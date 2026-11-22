// Live APM suite. Runs the real `apm` binary and the built CLI; needs APM on PATH. The local-plugin scenario needs no
// network; the Git-sourced scenario installs the test plugin from this repository's public HTTPS URL at two pinned commits
// (GIT_SOURCE, GIT_ROOT_SOURCE and GIT_SKILLS_SOURCE in test/lib/apm-live.ts) and needs the network and those commits on GitHub. Everything APM and the CLI write
// stays inside a disposable home under .tmp/, never the developer's real account.
//
//   TEST_APM_STRICT=true   a missing `apm` fails the suite instead of skipping it (CI sets this)
//   TEST_APM_VERSION=x.y.z the installed `apm` must report exactly this version (CI pins it)
//   TEST_APM_RECORD=true   also write test/fixtures/apm/<version>/<os>/ from this run (see README)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { appendFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseLock } from 'agent-plugin-lifecycle';
import spawn from 'cross-spawn-cb';
import { safeRmSync } from 'fs-remove-compat';
import { parse as parseYaml } from 'yaml';
import {
  type AnyStep,
  DEPENDENCY,
  deepShape,
  GIT_ROOT_SOURCE,
  GIT_ROOT_STEPS,
  GIT_SKILLS_SOURCE,
  GIT_SKILLS_STEPS,
  GIT_SOURCE,
  GIT_STEPS,
  type GitSource,
  gitLifecycleConfig,
  hashTree,
  isolatedEnvironment,
  lifecycleConfig,
  listFiles,
  loadRecording,
  makeAccount,
  osLabel,
  PLUGIN,
  packageRoot,
  pickRecording,
  pluginFixtures,
  quietLifecycleConfig,
  type RecordedStep,
  recordingsRoot,
  removeAccount,
  STEPS,
  tokenize,
} from '../lib/apm-live.ts';

const strict = process.env.TEST_APM_STRICT === 'true';
const record = process.env.TEST_APM_RECORD === 'true';
const wantedVersion = process.env.TEST_APM_VERSION;
const cli = join(packageRoot, 'bin', 'cli.js');
const capture = join(packageRoot, 'test', 'lib', 'capture-event.cjs');

let apmProblem = 'apm was not found on PATH';
function probe(): { version: string; commit: string | null } | undefined {
  // Even `apm --version` runs with the disposable home, so nothing is written to the real account.
  mkdirSync(join(packageRoot, '.tmp'), { recursive: true });
  const home = mkdtempSync(join(packageRoot, '.tmp', 'apm-probe-'));
  try {
    const result = spawn.sync('apm', ['--version'], { encoding: 'utf8', cwd: home, env: isolatedEnvironment(home) });
    if (result.error) {
      apmProblem = `spawning apm failed: ${result.error.message}`;
      return undefined;
    }
    if (result.status !== 0) {
      apmProblem = `apm --version exited ${result.status}${result.signal ? ` (${result.signal})` : ''}: ${String(result.stderr || result.stdout).trim()}`;
      return undefined;
    }
    const match = /(\d+\.\d+\.\d+\S*)(?:\s+\(([0-9a-f]+)\))?/.exec(String(result.stdout));
    if (!match) apmProblem = `apm --version printed no version: ${String(result.stdout).trim()}`;
    return match ? { version: match[1], commit: match[2] ?? null } : undefined;
  } catch (error) {
    // cross-spawn-cb throws (ENOENT) when the executable is not on PATH
    apmProblem = `spawning apm failed: ${error instanceof Error ? error.message : String(error)}`;
    return undefined;
  } finally {
    safeRmSync(home);
  }
}
const apm = probe();

const commands: string[] = [];
const recorded = {} as Record<AnyStep, RecordedStep>;
let recordedProvenance: Record<string, unknown> = {};

/** What `agent-plugin-lifecycle check` printed and exited with (a non-zero exit is a result here, not an error). */
interface CheckResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
/** A disposable account with `apm`, the built CLI and the event capture wired in as the user lifecycle commands. */
interface Session {
  root: string;
  home: string;
  plugins: string;
  env: NodeJS.ProcessEnv;
  apmRun: (args: string[]) => ReturnType<typeof spawn.sync>;
  check: () => CheckResult;
  lockText: () => Promise<string>;
  snapshot: (step: AnyStep) => Promise<{ lock: string; fresh: { file: string; payload: string }[] }>;
  inHome: (...parts: string[]) => Promise<string>;
  writeManifest: (dependencies: string) => Promise<void>;
}
async function openSession(prefix: string, config: unknown): Promise<Session> {
  const { root, home, plugins } = await makeAccount(prefix);
  const env = isolatedEnvironment(home);
  const eventsDir = join(root, 'events');
  const stepsSeen: AnyStep[] = [];
  const run = (command: string, args: string[], label: string) => {
    commands.push(label);
    const result = spawn.sync(command, args, { cwd: home, env, encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
  };
  const apmRun = (args: string[]) => {
    const result = run('apm', args, `apm ${args.join(' ')}`);
    assert.equal(result.status, 0, `apm ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const lockText = () => readFile(join(home, '.apm', 'apm.lock.yaml'), 'utf8');
  async function events(): Promise<{ file: string; payload: string }[]> {
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(eventsDir).catch(() => [] as string[])).sort();
    return Promise.all(files.map(async (file) => ({ file, payload: await readFile(join(eventsDir, file), 'utf8') })));
  }
  async function snapshot(step: AnyStep) {
    const all = await events();
    const seen = stepsSeen.reduce((count, name) => count + recorded[name].events.length, 0);
    const fresh = all.slice(seen);
    const locations = { home, plugins };
    recorded[step] = {
      lock: tokenize(await lockText().catch(() => ''), locations, false),
      events: fresh.map(({ file, payload }) => ({ file, payload: tokenize(payload, locations, true) })),
      deployed: await listFiles(home),
    };
    stepsSeen.push(step);
    return { lock: await lockText().catch(() => ''), fresh };
  }
  const quote = (text: string) => JSON.stringify(text);
  // the runner's own output goes to <root>/runner.log: kept where the test can read it
  const runnerLog = join(root, 'runner.log');
  const hooks = (event: string) => `  ${event}:\n    - run: ${quote(`node "${capture}" "${eventsDir}"`)}\n    - run: ${quote(`node "${cli}" run >> "${runnerLog}" 2>&1`)}\n`;
  const writeManifest = (dependencies: string) => writeFile(join(home, '.apm', 'apm.yml'), `name: apm-live-user\nversion: 0.0.0\nlifecycle:\n${hooks('post-install')}${hooks('post-update')}${hooks('post-uninstall')}dependencies:\n  apm:\n${dependencies}`);
  await mkdir(join(home, '.apm'), { recursive: true });
  const configDir = join(home, '.config', 'agent-plugin-lifecycle');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), JSON.stringify(config));
  return {
    root,
    home,
    plugins,
    env,
    apmRun,
    // cross-spawn-cb's sync form throws on a non-zero exit; the error carries the result's status, stdout and stderr
    check: (): CheckResult => {
      commands.push('agent-plugin-lifecycle check');
      try {
        const { status, stdout, stderr } = spawn.sync(process.execPath, [cli, 'check'], { cwd: home, env, encoding: 'utf8' });
        return { status, stdout: String(stdout), stderr: String(stderr) };
      } catch (error) {
        const failed = error as { status?: number | null; stdout?: string; stderr?: string; signal?: string | null };
        if (typeof failed.status !== 'number' || failed.signal) throw error;
        return { status: failed.status, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
      }
    },
    lockText,
    snapshot,
    inHome: async (...parts: string[]) => realpath(await readFile(join(home, ...parts), 'utf8')),
    writeManifest,
  };
}
const eventNames = (fresh: { file: string }[]) => fresh.map(({ file }) => file.replace(/^\d+-/, ''));
const quoteYaml = (text: string) => JSON.stringify(text);

describe('live APM lifecycle (real apm, user scope, disposable home)', function () {
  this.timeout(180000);
  let account: Session;

  before(async function () {
    if (!apm) {
      if (strict) throw new Error(`apm is not usable but TEST_APM_STRICT=true (${apmProblem}). Install APM (https://microsoft.github.io/apm/getting-started/installation/) or unset TEST_APM_STRICT.`);
      this.skip();
    }
    if (wantedVersion) assert.equal(apm.version, wantedVersion, `TEST_APM_VERSION=${wantedVersion} but apm reports ${apm.version}`);
    recordedProvenance = { apm_version: apm.version, apm_commit: apm.commit };
    account = await openSession('apm-live', lifecycleConfig(join(packageRoot, 'unused')));
    // the config names the plugins by their copied location, which exists only after makeAccount
    await writeFile(join(account.home, '.config', 'agent-plugin-lifecycle', 'config.json'), JSON.stringify(lifecycleConfig(account.plugins)));
    await account.writeManifest(`    - ${quoteYaml(join(account.plugins, PLUGIN))}\n    - ${quoteYaml(join(account.plugins, DEPENDENCY))}\n`);
  });

  after(async () => {
    if (account) removeAccount(account.root);
  });

  it('install: APM fires post-install, the runner runs the configured commands where APM deployed, and check passes', async () => {
    const { apmRun, snapshot, home, inHome, check } = account;
    apmRun(['install', '-g', '--target', 'copilot']);
    const { lock, fresh } = await snapshot('install');
    const rows = parseLock(parseYaml(lock));
    assert.deepEqual(rows.map((row) => row.repo).sort(), [`_local/${PLUGIN}`, `_local/${DEPENDENCY}`].sort());
    assert.deepEqual(eventNames(fresh), ['post-install.json']);
    const event = JSON.parse(fresh[0].payload);
    assert.deepEqual(event.packages.map((item: { name: string }) => item.name).sort(), [`_local/${PLUGIN}`, `_local/${DEPENDENCY}`].sort());
    const kept = (name: string) => join(home, '.apm', 'apm_modules', '_local', name);
    assert.equal(await inHome('.apm', 'apm_modules', '_local', PLUGIN, 'skills', 'greet', 'setup.done'), await realpath(home));
    assert.equal(await inHome('.apm', 'apm_modules', '_local', DEPENDENCY, 'skills', 'shout', 'setup.done'), await realpath(home));
    assert.equal(await readFile(join(kept(PLUGIN), 'installed.marker'), 'utf8'), 'yes');
    const result = check();
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });

  it('update: `apm update` leaves unchanged local plugins alone', async () => {
    account.apmRun(['update', '-g', '--yes']);
    const { fresh } = await account.snapshot('update');
    for (const { file } of fresh) assert.match(file, /-post-update\.json$/, 'update may fire only post-update');
    assert.equal(account.check().status, 0);
  });

  it('reinstall after the plugin changes: new content hash, post-install fires again, commands rerun', async () => {
    const { home, plugins, apmRun, snapshot, lockText, inHome, check } = account;
    const before = parseLock(parseYaml(await lockText())).find((row) => row.repo === `_local/${PLUGIN}`)?.revision;
    await appendFile(join(plugins, PLUGIN, 'skills', 'greet', 'SKILL.md'), '\nChanged for the reinstall step.\n');
    apmRun(['install', '-g', '--target', 'copilot']);
    const { lock, fresh } = await snapshot('reinstall');
    const after = parseLock(parseYaml(lock)).find((row) => row.repo === `_local/${PLUGIN}`)?.revision;
    assert.notEqual(after, before);
    assert.deepEqual(eventNames(fresh), ['post-install.json']);
    assert.match(await readFile(join(home, '.apm', 'apm_modules', '_local', PLUGIN, 'skills', 'greet', 'SKILL.md'), 'utf8'), /Changed for the reinstall step/);
    assert.equal(await inHome('.apm', 'apm_modules', '_local', PLUGIN, 'skills', 'greet', 'setup.done'), await realpath(home));
    assert.equal(check().status, 0);
  });

  it('uninstall: APM fires post-uninstall and the runner cleans up once from the home', async () => {
    const { home, apmRun, snapshot, check } = account;
    apmRun(['uninstall', '-g', `_local/${PLUGIN}`]);
    const { lock, fresh } = await snapshot('uninstall');
    assert.deepEqual(
      parseLock(parseYaml(lock)).map((row) => row.repo),
      [`_local/${DEPENDENCY}`]
    );
    assert.deepEqual(eventNames(fresh), ['post-uninstall.json']);
    assert.deepEqual(
      JSON.parse(fresh[0].payload).packages.map((item: { name: string }) => item.name),
      [`_local/${PLUGIN}`]
    );
    assert.equal(await readFile(join(home, 'cleanup.done'), 'utf8'), 'ok');
    await assert.rejects(() => stat(join(home, '.apm', 'apm_modules', '_local', PLUGIN)), { code: 'ENOENT' });
    assert.equal(check().status, 0);
  });
});

/** Why the pinned commits cannot be installed, or undefined when every pin is fetchable from the Git host. */
function unreachablePins(source: GitSource): string | undefined {
  mkdirSync(join(packageRoot, '.tmp'), { recursive: true });
  const dir = mkdtempSync(join(packageRoot, '.tmp', 'git-probe-'));
  const env = isolatedEnvironment(dir);
  const git = (args: string[]) => spawn.sync('git', args, { cwd: dir, env, encoding: 'utf8' }); // throws on a failing exit
  try {
    try {
      git(['init', '-q']);
    } catch (error) {
      return `git is not usable: ${error instanceof Error ? error.message : String(error)}`;
    }
    for (const sha of Object.values(source.pins)) {
      if (!sha) continue;
      try {
        git(['fetch', '-q', '--depth=1', `${source.url}.git`, sha]);
      } catch (error) {
        return `pinned commit ${sha} is not reachable at ${source.url} (${error instanceof Error ? error.message : String(error)}). The pins in test/lib/apm-live.ts must be reachable on that public host.`;
      }
    }
    return undefined;
  } finally {
    safeRmSync(dir);
  }
}

/**
 * One Git-sourced scenario against a real public repository: install at an old pin, update, uninstall. A `tag` source runs
 * `apm update` (APM moves the pin to the latest annotated release and fires post-update); a `pin` source edits the pin to a
 * second fixed commit and runs `apm install --update`. Only what holds for any newer release is asserted.
 */
function describeGitScenario(title: string, source: GitSource, steps: { install: AnyStep; update: AnyStep; uninstall: AnyStep }, prefix: string): void {
  describe(title, function () {
    this.timeout(600000);
    let account: Session;
    const { first, second } = source.pins;
    const whole = source.path === '.';
    const packageName = whole ? source.repo : `${source.repo}/${source.path}`;
    const dependency = (sha: string) => `    - git: ${source.url}.git\n${whole ? '' : `      path: ${source.path}\n`}      ref: ${sha}\n${source.select ? `      skills:\n${source.select.map((name) => `        - ${name}\n`).join('')}` : ''}`;
    const keptParts = ['.apm', 'apm_modules', ...source.repo.split('/'), ...(whole ? [] : source.path.split('/'))];
    const kept = (home: string, ...rest: string[]) => join(home, ...keptParts, ...rest);
    const row = async (lock: string) => {
      const rows = parseLock(parseYaml(lock));
      assert.equal(rows.length, 1, 'one locked Git package');
      return { plugin: rows[0], raw: (parseYaml(lock) as { dependencies: Record<string, unknown>[] }).dependencies[0] };
    };
    // The copies the lock reports for the skill (deployed or native), as absolute folders under the home. APM's kept copy is a
    // destination only when no other copy exists: a copilot-only package is read in place, anything else is APM's cache.
    const otherSkillCopies = (home: string, raw: Record<string, unknown>): string[] => {
      if (!source.skill) return [];
      const folders = new Set<string>();
      for (const file of (raw.deployed_files as string[] | undefined) ?? []) {
        const parts = file.split('/');
        const index = parts.lastIndexOf('skills');
        if (index >= 0 && parts[index + 1] === source.skill) folders.add(join(home, ...parts.slice(0, index + 2)));
      }
      const native = (raw.native_plugin as { root: string } | undefined)?.root;
      if (native) folders.add(join(home, ...native.split('/'), 'skills', source.skill));
      return [...folders];
    };
    const skillCopies = (home: string, raw: Record<string, unknown>): string[] => {
      const others = otherSkillCopies(home, raw);
      return source.skill && others.length === 0 ? [kept(home, 'skills', source.skill)] : others;
    };
    const keptIsWholeDestination = (raw: Record<string, unknown>): boolean => !(raw.native_plugin as { root: string } | undefined)?.root;
    const assertKeptCopy = async (home: string, raw: Record<string, unknown>, file: string, value: string): Promise<void> => {
      if (keptIsWholeDestination(raw)) assert.equal(await readFile(kept(home, file), 'utf8'), value, 'no native plugin copy exists, so the whole-package command runs in the kept copy');
      else await assert.rejects(() => stat(kept(home, file)), { code: 'ENOENT' }, `the plugin has its own copy, so ${file} must not be written into APM's kept copy`);
    };
    const assertKeptSkillUntouched = async (home: string, raw: Record<string, unknown>, file: string): Promise<void> => {
      if (source.skill && otherSkillCopies(home, raw).length > 0) await assert.rejects(() => stat(kept(home, 'skills', source.skill ?? '', file)), { code: 'ENOENT' }, `the skill has its own copies, so ${file} must not be written into APM's kept copy`);
    };

    before(async function () {
      if (!apm) {
        if (strict) throw new Error(`apm is not usable but TEST_APM_STRICT=true (${apmProblem}).`);
        this.skip();
      }
      const problem = unreachablePins(source);
      if (problem) {
        if (strict) throw new Error(`${problem} (TEST_APM_STRICT=true)`);
        console.log(`      skipping this Git-sourced scenario: ${problem}`);
        this.skip();
      }
      account = await openSession(prefix, gitLifecycleConfig(source));
      await account.writeManifest(dependency(first));
    });

    after(async () => {
      if (account) removeAccount(account.root);
    });

    it('install at the old pin: the lock records the Git source and commit, post-install fires, the commands run in every deployed copy, check passes', async () => {
      const { apmRun, snapshot, home, check } = account;
      apmRun(['install', '-g', '--target', source.target]);
      const { lock, fresh } = await snapshot(steps.install);
      const { plugin, raw } = await row(lock);
      assert.equal(raw.host, source.host);
      assert.equal(raw.repo_url, source.repo);
      assert.equal(raw.virtual_path ?? '.', source.path);
      assert.equal(raw.resolved_commit, first);
      assert.deepEqual([plugin.host, plugin.repo, plugin.path], [source.host, source.repo, source.path]);
      assert.deepEqual(eventNames(fresh), ['post-install.json']);
      await assertKeptCopy(home, raw, 'installed.marker', 'yes');
      await assertKeptSkillUntouched(home, raw, 'setup.done');
      const native = (raw.native_plugin as { root: string } | undefined)?.root;
      if (native) assert.equal(await readFile(join(home, ...native.split('/'), 'installed.marker'), 'utf8'), 'yes', 'the whole-package command also ran in the native plugin copy');
      for (const folder of skillCopies(home, raw)) {
        assert.equal(await readFile(join(folder, 'SKILL.md'), 'utf8').then((text) => text.length > 0), true, `${folder} holds the skill`);
        assert.equal(await readFile(join(folder, 'setup.done'), 'utf8'), home, `post-install ran in ${folder}`);
      }
      const result = check();
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    });

    it(`update (${source.update === 'tag' ? '`apm update` moves the pin to the latest release' : 'the pin is edited to a second fixed commit and `apm install --update` runs'}): the ref changed, the lifecycle event fires, the commands run in every deployed copy, check passes`, async () => {
      const { apmRun, snapshot, home, check, lockText, writeManifest } = account;
      const before = await row(await lockText());
      if (source.update === 'tag') apmRun(['update', '-g', '--yes', '--target', source.target]);
      else {
        assert.ok(second, 'a pin source needs a second commit');
        await writeManifest(dependency(second));
        apmRun(['install', '-g', '--update', '--target', source.target]);
      }
      const { lock, fresh } = await snapshot(steps.update);
      const { plugin, raw } = await row(lock);
      assert.notEqual(raw.resolved_commit, first, 'the locked commit moved');
      if (second) assert.equal(raw.resolved_commit, second);
      assert.notEqual(plugin.revision, before.plugin.revision);
      const names = eventNames(fresh);
      if (source.update === 'tag') assert.ok(names.includes('post-update.json'), `APM did not fire post-update: ${names}`);
      else assert.ok(names.includes('post-install.json'), `APM did not fire post-install: ${names}`);
      await assertKeptCopy(home, raw, source.update === 'tag' ? 'updated.marker' : 'installed.marker', 'yes');
      await assertKeptSkillUntouched(home, raw, source.update === 'tag' ? 'setup.updated' : 'setup.done');
      for (const folder of skillCopies(home, raw)) assert.equal(await readFile(join(folder, source.update === 'tag' ? 'setup.updated' : 'setup.done'), 'utf8'), home, `the update command ran in ${folder}`);
      const result = check();
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    });

    it('uninstall: APM fires post-uninstall and removes the kept copy', async () => {
      const { apmRun, snapshot, home } = account;
      apmRun(['uninstall', '-g', packageName]);
      const { fresh } = await snapshot(steps.uninstall);
      assert.deepEqual(eventNames(fresh), ['post-uninstall.json']);
      const named = JSON.parse(fresh[0].payload).packages.map((item: { name: string }) => item.name);
      assert.deepEqual(named, [packageName], 'the name APM sends on uninstall');
      await assert.rejects(() => stat(kept(home)), { code: 'ENOENT' });
    });

    it('uninstall: the runner runs the configured post-uninstall command once from the home', async () => {
      assert.equal(await readFile(join(account.home, 'cleanup.done'), 'utf8'), 'ok');
    });
  });
}

describeGitScenario('live APM lifecycle from a Git subfolder (anthropics/claude-plugins-official, plugins/commit-commands, no release tags)', GIT_SOURCE, { install: 'git-install', update: 'git-update', uninstall: 'git-uninstall' }, 'apm-live-git');
describeGitScenario('live APM lifecycle from a whole Git repository (obra/superpowers, pinned at v7.0.0)', GIT_ROOT_SOURCE, { install: 'gitroot-install', update: 'gitroot-update', uninstall: 'gitroot-uninstall' }, 'apm-live-gitroot');
describeGitScenario('live APM lifecycle from a plain skill repository (vercel-labs/skills, pinned at v1.2.0, skills: [find-skills])', GIT_SKILLS_SOURCE, { install: 'gitskills-install', update: 'gitskills-update', uninstall: 'gitskills-uninstall' }, 'apm-live-gitskills');

const lineCount = async (file: string): Promise<number> => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
const RESTORED = /Restored dependency cache/;

/**
 * A quiet `apm update` (nothing changed upstream) must not run a command and must not make APM restore its cache: the command's
 * output may not sit in APM's kept copy. Timing is printed, never asserted.
 */
describe('live APM quiet update (vercel-labs/skills, a command that makes node_modules)', function () {
  this.timeout(600000);
  const source = GIT_SKILLS_SOURCE;
  let account: Session;
  let runLog = '';
  const keptSkill = (home: string, ...rest: string[]) => join(home, '.apm', 'apm_modules', ...source.repo.split('/'), 'skills', source.skill ?? '', ...rest);

  before(async function () {
    if (!apm) {
      if (strict) throw new Error(`apm is not usable but TEST_APM_STRICT=true (${apmProblem}).`);
      this.skip();
    }
    const problem = unreachablePins(source);
    if (problem) {
      if (strict) throw new Error(`${problem} (TEST_APM_STRICT=true)`);
      console.log(`      skipping the quiet-update scenario: ${problem}`);
      this.skip();
    }
    const probe = await makeAccount('apm-live-quiet');
    removeAccount(probe.root);
    runLog = join(probe.root, 'run.log');
    account = await openSession('apm-live-quiet', quietLifecycleConfig(source, join(probe.root, 'run.log')));
    runLog = join(account.root, 'run.log');
    await writeFile(join(account.home, '.config', 'agent-plugin-lifecycle', 'config.json'), JSON.stringify(quietLifecycleConfig(source, runLog)));
    await account.writeManifest(`    - git: ${source.url}.git\n      ref: ${source.pins.first}\n      skills:\n${(source.select ?? []).map((name) => `        - ${name}\n`).join('')}`);
  });

  after(async () => {
    if (account) removeAccount(account.root);
  });

  it("install, then a real update: the command ran in the skill copies APM deployed and left APM's kept copy untouched", async () => {
    const { apmRun, home, check } = account;
    apmRun(['install', '-g', '--target', source.target]);
    apmRun(['update', '-g', '--yes', '--target', source.target]);
    assert.ok((await lineCount(runLog)) > 0, 'the command ran');
    const copy = join(home, '.agents', 'skills', source.skill ?? '');
    assert.equal(await readFile(join(copy, 'node_modules', 'marker.json'), 'utf8'), '{}', 'the deployed copy holds the command output');
    await assert.rejects(() => stat(keptSkill(home, 'node_modules')), { code: 'ENOENT' }, "APM's kept copy must hold no node_modules");
    const result = check();
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });

  it('a quiet `apm update` runs no command, makes APM restore nothing, and leaves the kept copy clean', async () => {
    const { env, home } = account;
    const before = await lineCount(runLog);
    const timed = (extra: NodeJS.ProcessEnv) => {
      const start = Date.now();
      const result = spawn.sync('apm', ['update', '-g', '--yes', '--target', source.target], { cwd: home, env: { ...env, ...extra }, encoding: 'utf8' });
      return { result, ms: Date.now() - start, output: `${result.stdout}${result.stderr}` };
    };
    const quiet = timed({});
    assert.equal(quiet.result.status, 0, quiet.output);
    // the baseline: the same update with APM's lifecycle commands switched off (run twice, so a cache restore cannot be what is timed)
    timed({ APM_NO_SCRIPTS: '1' });
    const baseline = timed({ APM_NO_SCRIPTS: '1' });
    console.log(`      quiet update with the lifecycle commands: ${quiet.ms} ms; with APM_NO_SCRIPTS=1: ${baseline.ms} ms (recorded, not asserted)`);
    assert.equal(await lineCount(runLog), before, `a quiet update ran the command ${(await lineCount(runLog)) - before} more time(s)`);
    assert.doesNotMatch(quiet.output, RESTORED);
    await assert.rejects(() => stat(keptSkill(home, 'node_modules')), { code: 'ENOENT' });
  });

  it('uninstall: APM keeps the skill folder holding the command output and says so; the runner prints `left <path>`; check says nothing installed', async () => {
    const { env, home, root, check } = account;
    const copy = join(home, '.agents', 'skills', source.skill ?? '');
    const result = spawn.sync('apm', ['uninstall', '-g', source.repo], { cwd: home, env, encoding: 'utf8' });
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, output);
    console.log(`      uninstall output:\n${output.replace(/^/gm, '        ')}`);
    assert.match(output, /Kept skill director/i, "APM's own message about the folder it kept");
    assert.ok((await stat(join(copy, 'node_modules'))).isDirectory(), 'the folder with the command output stays');
    const runner = await readFile(join(root, 'runner.log'), 'utf8');
    assert.ok(runner.includes(`left ${copy}`) || runner.includes(`left ${await realpath(copy)}`), `the runner prints left <path> for the kept copy:\n${runner}`);
    const none = check();
    assert.equal(none.status, 0, `${none.stdout}${none.stderr}`);
    assert.match(`${none.stdout}${none.stderr}`, /nothing installed/);
  });
});

/**
 * A skill (or whole plugin) whose only copy is APM's kept copy (the copilot target reads it in place) still has its command run
 * there. Measured with real APM: that output makes the next quiet `apm update` restore the cache and fire the events.
 */
describe('live APM copilot-only Git plugin (the kept copy is the only copy)', function () {
  this.timeout(600000);
  const source = GIT_SOURCE;
  let account: Session;
  let runLog = '';
  const kept = (home: string, ...rest: string[]) => join(home, '.apm', 'apm_modules', ...source.repo.split('/'), ...source.path.split('/'), ...rest);

  before(async function () {
    if (!apm) {
      if (strict) throw new Error(`apm is not usable but TEST_APM_STRICT=true (${apmProblem}).`);
      this.skip();
    }
    const problem = unreachablePins(source);
    if (problem) {
      if (strict) throw new Error(`${problem} (TEST_APM_STRICT=true)`);
      console.log(`      skipping the copilot-only scenario: ${problem}`);
      this.skip();
    }
    account = await openSession('apm-live-copilot', { version: 1, plugins: [] });
    runLog = join(account.root, 'run.log');
    await writeFile(join(account.home, '.config', 'agent-plugin-lifecycle', 'config.json'), JSON.stringify(quietLifecycleConfig(source, runLog)));
    await account.writeManifest(`    - git: ${source.url}.git\n      path: ${source.path}\n      ref: ${source.pins.first}\n`);
  });

  after(async () => {
    if (account) removeAccount(account.root);
  });

  it('the command runs in the kept copy (the only copy); APM restores its cache on the next quiet update; the receipt then skips the command', async () => {
    const { apmRun, env, home, snapshot } = account;
    apmRun(['install', '-g', '--target', source.target]);
    await snapshot('git-install');
    assert.equal(await readFile(kept(home, 'node_modules', 'marker.json'), 'utf8'), '{}', 'the command ran in the kept copy');
    const afterInstall = await lineCount(runLog);
    const update = () => {
      const result = spawn.sync('apm', ['update', '-g', '--yes', '--target', source.target], { cwd: home, env, encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      return `${result.stdout}${result.stderr}`;
    };
    const first = update();
    console.log(`      copilot-only, first quiet update: ${RESTORED.test(first) ? 'APM restored its dependency cache' : 'APM did not restore its cache'}`);
    assert.match(first, RESTORED, 'output in the only copy is drift to APM (an APM limitation the README documents)');
    // with the receipt skipping a copy that is already current, the restore does not trigger another command round
    assert.equal(await lineCount(runLog), afterInstall, 'the receipt skip: the restore fired the events but the command did not run again');
    assert.doesNotMatch(update(), RESTORED, 'the second quiet update is settled');
  });
});

describe('live check against real APM state (vercel-labs/skills)', function () {
  this.timeout(600000);
  const source = GIT_SKILLS_SOURCE;
  let account: Session;

  before(async function () {
    if (!apm) {
      if (strict) throw new Error(`apm is not usable but TEST_APM_STRICT=true (${apmProblem}).`);
      this.skip();
    }
    const problem = unreachablePins(source);
    if (problem) {
      if (strict) throw new Error(`${problem} (TEST_APM_STRICT=true)`);
      console.log(`      skipping the check scenario: ${problem}`);
      this.skip();
    }
    account = await openSession('apm-live-check', { version: 1, plugins: [] });
    await writeFile(join(account.home, '.config', 'agent-plugin-lifecycle', 'config.json'), JSON.stringify(quietLifecycleConfig(source, join(account.root, 'run.log'))));
    await account.writeManifest(`    - git: ${source.url}.git\n      ref: ${source.pins.first}\n      skills:\n${(source.select ?? []).map((name) => `        - ${name}\n`).join('')}`);
  });

  after(async () => {
    if (account) removeAccount(account.root);
  });

  it('a copy removed by hand: check prints broken and exits 1; after `apm uninstall` of everything it prints nothing installed and exits 0', async () => {
    const { apmRun, home, check } = account;
    apmRun(['install', '-g', '--target', source.target]);
    const ok = check();
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
    safeRmSync(join(home, '.agents', 'skills', source.skill ?? ''));
    const broken = check();
    assert.equal(broken.status, 1, `${broken.stdout}${broken.stderr}`);
    assert.match(String(broken.stdout) + String(broken.stderr), /broken/);
    apmRun(['uninstall', '-g', source.repo]);
    const none = check();
    assert.equal(none.status, 0, `${none.stdout}${none.stderr}`);
    assert.match(String(none.stdout) + String(none.stderr), /nothing installed/);
  });
});

const provenanceOf = (source: GitSource) => ({ url: source.url, path: source.path, skill: source.skill, select: source.select, update: source.update, target: source.target, first: source.pins.first, second: source.pins.second });

describe('live APM recordings', function () {
  this.timeout(180000);

  it('the lock and event shapes (field names and types) match the recorded fixtures', async function () {
    if (record || !apm || !recorded.install) return this.skip();
    const dir = await pickRecording(apm.version, osLabel());
    assert.ok(dir, `no recording under ${recordingsRoot}; record one with TEST_APM_RECORD=true (see README)`);
    const fixture = await loadRecording(dir);
    const compare = (step: AnyStep, expected: RecordedStep) => {
      assert.deepEqual(deepShape(parseYaml(recorded[step].lock)), deepShape(parseYaml(expected.lock)), `${step}: apm.lock.yaml shape changed from the recording in ${dir}; record a new fixture and review the runner`);
      assert.deepEqual(
        recorded[step].events.map(({ payload }) => deepShape(JSON.parse(payload))),
        expected.events.map(({ payload }) => deepShape(JSON.parse(payload))),
        `${step}: event payload shape changed from the recording in ${dir}; record a new fixture and review the runner`
      );
    };
    for (const step of STEPS) compare(step, fixture.steps[step]);
    if (recorded[GIT_STEPS[0]] && fixture.gitSteps) for (const step of GIT_STEPS) compare(step, fixture.gitSteps[step]);
    if (recorded[GIT_ROOT_STEPS[0]] && fixture.gitRootSteps) for (const step of GIT_ROOT_STEPS) compare(step, fixture.gitRootSteps[step]);
    if (recorded[GIT_SKILLS_STEPS[0]] && fixture.gitSkillsSteps) for (const step of GIT_SKILLS_STEPS) compare(step, fixture.gitSkillsSteps[step]);
  });

  // Runs last: writes what the scenarios above saw. The local scenario is required; the Git scenario is recorded when it ran.
  it('records the run when TEST_APM_RECORD=true', async function () {
    if (!record || !apm) return this.skip();
    assert.equal(Object.keys(recorded).length >= STEPS.length, true, 'the local scenario did not complete, so there is nothing to record');
    await writeRecording();
  });

  async function writeRecording(): Promise<void> {
    const dir = join(recordingsRoot, apm?.version ?? 'unknown', osLabel());
    const steps = [...STEPS, ...GIT_STEPS, ...GIT_ROOT_STEPS, ...GIT_SKILLS_STEPS].filter((step) => recorded[step]);
    safeRmSync(dir);
    for (const step of steps) {
      const base = join(dir, 'steps', step);
      await mkdir(join(base, 'events'), { recursive: true });
      await writeFile(join(base, 'apm.lock.yaml'), recorded[step].lock);
      await writeFile(join(base, 'deployed.json'), `${JSON.stringify(recorded[step].deployed, null, 2)}\n`);
      for (const { file, payload } of recorded[step].events) await writeFile(join(base, 'events', file), `${JSON.stringify(JSON.parse(payload), null, 2)}\n`);
    }
    const provenance = {
      kind: 'recording of real APM runs; a change detector for the APM lock and event schema, not a correctness oracle',
      ...recordedProvenance,
      os: osLabel(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      recorded_at: new Date().toISOString(),
      environment: process.env.TEST_APM_RECORD_ENVIRONMENT ?? null,
      plugin_fixtures_sha256: await hashTree(pluginFixtures),
      git_skills_source: recorded[GIT_SKILLS_STEPS[0]] ? provenanceOf(GIT_SKILLS_SOURCE) : null,
      git_root_source: recorded[GIT_ROOT_STEPS[0]] ? provenanceOf(GIT_ROOT_SOURCE) : null,
      git_source: recorded[GIT_STEPS[0]] ? provenanceOf(GIT_SOURCE) : null,
      commands,
      paths: 'absolute paths are stored as <HOME> (the recorded account home) and <PLUGINS> (the plugin source copy)',
    };
    await writeFile(join(dir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  }
});
