// Live APM suite. Runs the real `apm` binary and the built CLI; needs APM on PATH. The local-plugin scenario needs no
// network; the Git-sourced scenario installs the test plugin from this repository's public HTTPS URL at two pinned commits
// (GIT_SOURCE and GIT_ROOT_SOURCE in test/lib/apm-live.ts) and needs the network and those commits on GitHub. Everything APM and the CLI write
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

/** A disposable account with `apm`, the built CLI and the event capture wired in as the user lifecycle commands. */
interface Session {
  root: string;
  home: string;
  plugins: string;
  env: NodeJS.ProcessEnv;
  apmRun: (args: string[]) => ReturnType<typeof spawn.sync>;
  check: () => ReturnType<typeof spawn.sync>;
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
  const hooks = (event: string) => `  ${event}:\n    - run: ${quote(`node "${capture}" "${eventsDir}"`)}\n    - run: ${quote(`node "${cli}" run`)}\n`;
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
    check: () => run(process.execPath, [cli, 'check'], 'agent-plugin-lifecycle check'),
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

/** Why the pinned commits cannot be installed, or undefined when both are fetchable from the Git host. */
function unreachablePins(source: GitSource): string | undefined {
  mkdirSync(join(packageRoot, '.tmp'), { recursive: true });
  const dir = mkdtempSync(join(packageRoot, '.tmp', 'git-probe-'));
  const env = isolatedEnvironment(dir);
  const git = (args: string[]) => spawn.sync('git', args, { cwd: dir, env, encoding: 'utf8', timeout: 90000 }); // throws on a failing exit
  try {
    try {
      git(['init', '-q']);
    } catch (error) {
      return `git is not usable: ${error instanceof Error ? error.message : String(error)}`;
    }
    for (const { sha } of Object.values(source.pins)) {
      try {
        git(['fetch', '-q', '--depth=1', `${source.url}.git`, sha]);
      } catch (error) {
        return `pinned commit ${sha} is not reachable at ${source.url} (${error instanceof Error ? error.message : String(error)}). The two pinned commits on branch ${source.branch} (test/lib/apm-live.ts) must be pushed to GitHub, and the host must be reachable.`;
      }
    }
    return undefined;
  } finally {
    safeRmSync(dir);
  }
}

/** One Git-sourced scenario: install at the first pin, edit the pin to the second and `apm update`, uninstall. */
function describeGitScenario(title: string, source: GitSource, steps: { install: AnyStep; update: AnyStep; uninstall: AnyStep }, prefix: string): void {
  describe(title, function () {
    this.timeout(300000);
    let account: Session;
    const { first, second } = source.pins;
    const whole = source.path === '.';
    const packageName = whole ? source.repo : `${source.repo}/${source.path}`;
    const dependency = (sha: string) => `    - git: ${source.url}.git\n${whole ? '' : `      path: ${source.path}\n`}      ref: ${sha}\n`;
    const keptParts = ['.apm', 'apm_modules', ...source.repo.split('/'), ...(whole ? [] : source.path.split('/'))];
    const kept = (home: string, ...rest: string[]) => join(home, ...keptParts, ...rest);
    const row = async (lock: string) => {
      const rows = parseLock(parseYaml(lock));
      assert.equal(rows.length, 1, 'one locked Git plugin');
      return { plugin: rows[0], raw: (parseYaml(lock) as { dependencies: Record<string, unknown>[] }).dependencies[0] };
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
      await account.writeManifest(dependency(first.sha));
    });

    after(async () => {
      if (account) removeAccount(account.root);
    });

    it('install at the first pinned commit: the lock records the Git source and commit, post-install fires, the commands run, check passes', async () => {
      const { apmRun, snapshot, home, check, inHome } = account;
      apmRun(['install', '-g', '--target', 'copilot']);
      const { lock, fresh } = await snapshot(steps.install);
      const { plugin, raw } = await row(lock);
      assert.equal(raw.host, source.host);
      assert.equal(raw.repo_url, source.repo);
      assert.equal(raw.virtual_path ?? '.', source.path);
      assert.equal(raw.resolved_commit, first.sha);
      assert.deepEqual([plugin.host, plugin.repo, plugin.path], [source.host, source.repo, source.path]);
      assert.deepEqual(eventNames(fresh), ['post-install.json']);
      assert.match(await readFile(kept(home, 'skills', 'greet', 'SKILL.md'), 'utf8'), new RegExp(first.content));
      assert.equal(await readFile(kept(home, 'installed.marker'), 'utf8'), 'yes');
      assert.equal(await inHome(...keptParts, 'skills', 'greet', 'setup.done'), await realpath(home));
      const result = check();
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    });

    it('update to the second pinned commit: apm.yml moves the pin, `apm update` fires post-update, the runner runs it, check passes', async () => {
      const { apmRun, snapshot, home, check, lockText, writeManifest } = account;
      const before = (await row(await lockText())).plugin.revision;
      await writeManifest(dependency(second.sha));
      apmRun(['update', '-g', '--yes']);
      const { lock, fresh } = await snapshot(steps.update);
      const { plugin, raw } = await row(lock);
      assert.equal(raw.resolved_commit, second.sha);
      assert.notEqual(plugin.revision, before);
      // APM 0.37.0 fires post-install (it re-materialises the package) and then post-update for a moved pin
      assert.deepEqual(eventNames(fresh), ['post-install.json', 'post-update.json']);
      assert.match(await readFile(kept(home, 'skills', 'greet', 'SKILL.md'), 'utf8'), new RegExp(second.content));
      assert.equal(await readFile(kept(home, 'updated.marker'), 'utf8'), 'yes');
      assert.equal(await readFile(kept(home, 'skills', 'greet', 'setup.updated'), 'utf8'), home);
      const result = check();
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    });

    it('uninstall: APM fires post-uninstall and removes the kept copy', async () => {
      const { apmRun, snapshot, home } = account;
      apmRun(['uninstall', '-g', packageName]);
      const { fresh } = await snapshot(steps.uninstall);
      assert.deepEqual(eventNames(fresh), ['post-uninstall.json']);
      const named = JSON.parse(fresh[0].payload).packages.map((item: { name: string }) => item.name);
      assert.equal(named.length, 1, `post-uninstall named ${JSON.stringify(named)}`);
      assert.equal(named[0], packageName, 'the name APM sends on uninstall');
      await assert.rejects(() => stat(kept(home)), { code: 'ENOENT' });
    });

    it('uninstall: the runner runs the configured post-uninstall command once from the home', async () => {
      assert.equal(await readFile(join(account.home, 'cleanup.done'), 'utf8'), 'ok');
    });
  });
}

describeGitScenario('live APM lifecycle from a Git subfolder (this repository on GitHub, branch apm-test-plugin, two pinned commits)', GIT_SOURCE, { install: 'git-install', update: 'git-update', uninstall: 'git-uninstall' }, 'apm-live-git');
describeGitScenario('live APM lifecycle from a whole Git repository (this repository on GitHub, branch apm-test-plugin-root, two pinned commits)', GIT_ROOT_SOURCE, { install: 'gitroot-install', update: 'gitroot-update', uninstall: 'gitroot-uninstall' }, 'apm-live-gitroot');

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
  });

  // Runs last: writes what the scenarios above saw. The local scenario is required; the Git scenario is recorded when it ran.
  it('records the run when TEST_APM_RECORD=true', async function () {
    if (!record || !apm) return this.skip();
    assert.equal(Object.keys(recorded).length >= STEPS.length, true, 'the local scenario did not complete, so there is nothing to record');
    await writeRecording();
  });

  async function writeRecording(): Promise<void> {
    const dir = join(recordingsRoot, apm?.version ?? 'unknown', osLabel());
    const steps = [...STEPS, ...GIT_STEPS, ...GIT_ROOT_STEPS].filter((step) => recorded[step]);
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
      git_root_source: recorded[GIT_ROOT_STEPS[0]] ? { url: GIT_ROOT_SOURCE.url, path: GIT_ROOT_SOURCE.path, first: GIT_ROOT_SOURCE.pins.first.sha, second: GIT_ROOT_SOURCE.pins.second.sha } : null,
      git_source: recorded[GIT_STEPS[0]] ? { url: GIT_SOURCE.url, path: GIT_SOURCE.path, first: GIT_SOURCE.pins.first.sha, second: GIT_SOURCE.pins.second.sha } : null,
      commands,
      paths: 'absolute paths are stored as <HOME> (the recorded account home) and <PLUGINS> (the plugin source copy)',
    };
    await writeFile(join(dir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  }
});
