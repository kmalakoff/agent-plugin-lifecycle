// Live APM suite: runs the real `apm` binary and the built `apl` CLI; needs APM on PATH. The local scenarios need no network; the
// Git scenarios install three public GitHub repositories at pinned commits (GIT_SOURCE, GIT_ROOT_SOURCE and GIT_SKILLS_SOURCE in
// test/lib/apm-live.ts) and need the network. Everything APM and apl write stays inside a disposable home under .tmp/.
//
//   TEST_APM_STRICT=true   a missing `apm` fails the suite instead of skipping it (the APM workflow sets this)
//   TEST_APM_VERSION=x.y.z the installed `apm` must report exactly this version
//   TEST_APM_RECORD=true   also write test/fixtures/apm/<version>/<os>/ from this run (see test/README.md)

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'assert';
import spawn from 'cross-spawn-cb';
import { safeRmSync } from 'fs-remove-compat';
import { parse as parseYaml } from 'yaml';
import { parseLock } from '../../src/apm.ts';
import { CACHE_ONLY } from '../../src/constants.ts';
import {
  ALL_STEPS,
  type AnyStep,
  APL_EVENT,
  APM_EVENTS,
  CLAUDE_DIR_STEPS,
  type ClaudeDirStep,
  DEPENDENCY,
  deepShape,
  EVENTS_FILE,
  expectedCopies,
  GIT_MANIFEST,
  GIT_ROOT_SOURCE,
  GIT_ROOT_STEPS,
  GIT_SKILLS_SOURCE,
  GIT_SKILLS_STEPS,
  GIT_SOURCE,
  GIT_STEPS,
  type GitSource,
  gitCopyFolders,
  hashTree,
  isolatedEnvironment,
  listFiles,
  loadRecording,
  makeAccount,
  osLabel,
  PLUGIN,
  PROJECT,
  PROJECT_STEPS,
  packageRoot,
  pickRecording,
  pluginFixtures,
  type RecordedStep,
  recordingsRoot,
  removeAccount,
  STEPS,
  tokenize,
} from '../lib/apm-live.ts';
import { type Line, parseLines } from '../lib/output.ts';
import { type Result, runCommand as run } from '../lib/spawn.ts';

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
    const match = /(\d+\.\d+\.\d+\S*)(?:\s+\(([0-9a-f]+)\))?/.exec(String(result.stdout));
    if (!match) apmProblem = `apm --version printed no version: ${String(result.stdout).trim()}`;
    return match ? { version: match[1], commit: match[2] ?? null } : undefined;
  } catch (error) {
    // cross-spawn-cb throws when the executable is not on PATH or exits non-zero
    apmProblem = `spawning apm failed: ${error instanceof Error ? error.message : String(error)}`;
    return undefined;
  } finally {
    safeRmSync(home);
  }
}
const apm = probe();

const commands: string[] = [];
const recorded = {} as Record<AnyStep, RecordedStep>;

/** A disposable account with the event capture on each event and `apl install` on `post-install` alone in the user `apm.yml`, as the README registers it. */
interface Session {
  root: string;
  home: string;
  outside: string;
  project: string;
  plugins: string;
  apm: (args: string[], cwd?: string) => Result;
  apl: (args: string[], cwd?: string) => Result;
  /** What `apl install`, run by APM's lifecycle entries, printed since the last call. */
  hookOutput: () => Promise<string>;
  /** Forgets the events fired since the last snapshot, for a command no step records. */
  discardEvents: () => Promise<void>;
  /** Records the step: the lock, the names of the events fired since the last snapshot and the files under `root`. */
  snapshot: (step: AnyStep, root: string, lock: string) => Promise<RecordedStep>;
  writeUserManifest: (dependencies: string) => Promise<void>;
  writeProjectManifest: (dependencies: string) => Promise<void>;
}
/** `environment` adds variables for apm and apl, given the account (the CLAUDE_CONFIG_DIR scenario moves a harness folder). */
async function openSession(prefix: string, environment: (account: { home: string; outside: string }) => NodeJS.ProcessEnv = () => ({})): Promise<Session> {
  const { root, home, plugins, outside } = await makeAccount(prefix);
  const project = join(home, PROJECT);
  await mkdir(project, { recursive: true });
  await mkdir(join(home, '.apm'), { recursive: true });
  const env = isolatedEnvironment(home, environment({ home, outside }));
  const eventsDir = join(root, 'events');
  const runnerLog = join(root, 'runner.log');
  let eventsSeen = 0;
  let hookSeen = 0;
  const quote = (text: string) => JSON.stringify(text);
  const captureEntry = `    - run: ${quote(`node "${capture}" "${eventsDir}"`)}\n`;
  const aplEntry = `    - run: ${quote(`node "${cli}" install >> "${runnerLog}" 2>&1`)}\n      timeoutSec: 300\n`;
  const lifecycle = `lifecycle:\n${APM_EVENTS.map((event) => `  ${event}:\n${captureEntry}${event === APL_EVENT ? aplEntry : ''}`).join('')}`;
  const locations = { home, plugins, outside };
  return {
    root,
    home,
    outside,
    project,
    plugins,
    apm: (args, cwd = home) => {
      commands.push(`apm ${args.join(' ')}`);
      const result = run('apm', args, cwd, env);
      assert.strictEqual(result.status, 0, `apm ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
      return result;
    },
    apl: (args, cwd = root) => {
      commands.push(`apl ${args.join(' ')}`);
      return run(process.execPath, [cli, ...args], cwd, env);
    },
    hookOutput: async () => {
      const text = await readFile(runnerLog, 'utf8').catch(() => '');
      const fresh = text.slice(hookSeen);
      hookSeen = text.length;
      return fresh;
    },
    discardEvents: async () => {
      eventsSeen = (await readdir(eventsDir).catch(() => [] as string[])).length;
    },
    snapshot: async (step, scopeRoot, lock) => {
      const files = (await readdir(eventsDir).catch(() => [] as string[])).sort();
      const fresh = files.slice(eventsSeen);
      eventsSeen = files.length;
      recorded[step] = {
        lock: tokenize(await readFile(lock, 'utf8').catch(() => ''), locations, false),
        // `NNN-<event>.json`, written by capture-event.cjs
        events: fresh.map((file) => file.replace(/^\d+-/, '').replace(/\.json$/, '')),
        deployed: await listFiles(scopeRoot),
      };
      return recorded[step];
    },
    writeUserManifest: (dependencies) => writeFile(join(home, '.apm', 'apm.yml'), `name: apm-live-user\nversion: 0.0.0\n${lifecycle}dependencies:\n${dependencies ? `  apm:\n${dependencies}` : '  apm: []\n'}`),
    writeProjectManifest: (dependencies) => writeFile(join(project, 'apm.yml'), `name: apm-live-project\nversion: 0.0.0\ndependencies:\n  apm:\n${dependencies}`),
  };
}
const folders = (lines: Line[]) => lines.map((line) => line.folder).sort();
function skipWithoutApm(context: Mocha.Context): void {
  if (apm) return;
  if (strict) throw new Error(`apm is not usable but TEST_APM_STRICT=true (${apmProblem}). Install APM (https://microsoft.github.io/apm/getting-started/installation/) or unset TEST_APM_STRICT.`);
  context.skip();
}

/** The two test plugins from local paths at one scope: APM deploys their `apl.json`, its lifecycle entries run `apl install`. */
function describeLocalScenario(scope: 'user' | 'project'): void {
  const user = scope === 'user';
  const [installStep, updateStep, reinstallStep, uninstallStep] = user ? STEPS : PROJECT_STEPS;
  const g = user ? ['-g'] : [];
  describe(`live APM, local plugins, ${user ? 'user scope (-g)' : 'project scope'}`, () => {
    let session: Session;
    let root = '';
    let lock = '';
    let copies: string[] = [];
    // apl is run where a person would run it: anywhere for -g, the project root otherwise
    const apl = (args: string[]) => session.apl([...args.slice(0, 1), ...g, ...args.slice(1)], user ? session.root : session.project);
    const ofPlugin = (id: string | undefined) => !!id && (id === join(session.plugins, PLUGIN) || id.startsWith(`${join(session.plugins, PLUGIN)}:`));

    before(async function () {
      skipWithoutApm(this);
      if (wantedVersion) assert.strictEqual(apm?.version, wantedVersion, `TEST_APM_VERSION=${wantedVersion} but apm reports ${apm?.version}`);
      session = await openSession(`apm-live-${scope}`);
      root = user ? session.home : session.project;
      lock = user ? join(session.home, '.apm', 'apm.lock.yaml') : join(session.project, 'apm.lock.yaml');
      const dependencies = `    - ${JSON.stringify(join(session.plugins, PLUGIN))}\n    - ${JSON.stringify(join(session.plugins, DEPENDENCY))}\n`;
      await session.writeUserManifest(user ? dependencies : '');
      if (!user) await session.writeProjectManifest(dependencies);
    });
    after(() => {
      if (session) removeAccount(session.root);
    });

    it('install: APM deploys apl.json, its entry runs `apl install`, which runs nothing unapproved; `apl install -y` approves and runs each copy', async () => {
      session.apm(['install', ...g, '--target', 'copilot'], root);
      const step = await session.snapshot(installStep, root, lock);
      assert.deepStrictEqual(step.events, ['post-install']);
      copies = expectedCopies(root, step.deployed);
      assert.ok(copies.length >= 3, `APM deployed apl.json into ${copies.length} copies:\n${step.deployed.join('\n')}`);
      const hook = parseLines(await session.hookOutput());
      assert.deepStrictEqual(folders(hook), copies, 'the entry reported every copy');
      assert.ok(
        hook.every((line) => line.status === 'unapproved'),
        'nothing is approved yet'
      );
      const result = apl(['install', '-y']);
      assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      const ran = parseLines(result.stdout);
      assert.deepStrictEqual(folders(ran), copies);
      assert.ok(ran.every((line) => line.status === 'ran'));
      for (const copy of copies) assert.ok(existsSync(join(copy, 'installed.marker')) || existsSync(join(copy, 'setup.done')), `the script ran in ${copy}`);
      const status = apl(['status']);
      assert.strictEqual(status.status, 0, `${status.stdout}${status.stderr}`);
      assert.ok(parseLines(status.stdout).every((line) => line.status === 'ok'));
    });

    it('update: `apm update` changes nothing, so the entry finds every copy current', async () => {
      session.apm(['update', ...g, '--yes', '--target', 'copilot'], root);
      await session.snapshot(updateStep, root, lock);
      const hook = parseLines(await session.hookOutput());
      assert.ok(
        hook.every((line) => line.status === 'current'),
        `a quiet update ran something:\n${hook.map((line) => line.text).join('\n')}`
      );
      const status = apl(['status']);
      assert.strictEqual(status.status, 0, `${status.stdout}${status.stderr}`);
    });

    it("reinstall after the plugin changes: the entry runs that plugin's approved scripts again, without asking", async () => {
      await appendFile(join(session.plugins, PLUGIN, 'skills', 'greet', 'SKILL.md'), '\nChanged for the reinstall step.\n');
      session.apm(['install', ...g, '--target', 'copilot'], root);
      const step = await session.snapshot(reinstallStep, root, lock);
      assert.deepStrictEqual(step.events, ['post-install']);
      const hook = parseLines(await session.hookOutput());
      assert.deepStrictEqual(folders(hook), copies);
      for (const line of hook) assert.strictEqual(line.status, ofPlugin(line.id) ? 'ran' : 'current', line.text);
      const status = apl(['status']);
      assert.strictEqual(status.status, 0, `${status.stdout}${status.stderr}`);
    });

    it('uninstall: `apl status` reports `left` for each copy APM kept, the rest stay ok, exit 0', async () => {
      const before = parseLines(apl(['status']).stdout);
      session.apm(['uninstall', ...g, `_local/${PLUGIN}`], root);
      await session.snapshot(uninstallStep, root, lock);
      const status = apl(['status']);
      assert.strictEqual(status.status, 0, `${status.stdout}${status.stderr}`);
      const lines = parseLines(status.stdout);
      const kept = before.filter((line) => ofPlugin(line.id) && existsSync(line.folder)).map((line) => line.folder);
      assert.deepStrictEqual(folders(lines.filter((line) => line.status === 'left')), kept.sort());
      assert.deepStrictEqual(folders(lines.filter((line) => line.status === 'ok')), folders(before.filter((line) => !ofPlugin(line.id))));
      console.log(`      APM kept ${kept.length} of the removed plugin's copies (the scripts' markers are files APM did not write)`);
    });
  });
}
describeLocalScenario('user');
describeLocalScenario('project');

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
 * One public repository at user scope: install at an old pin, update, a quiet update, uninstall. The repository ships no `apl.json`, so
 * the test adds one to each copy APM deployed; what is proved is that apl finds the copies of this layout. Only what holds for any
 * newer release of the repository is asserted.
 */
/** `apl` printed one `skipped` line for the cache folder, with the reason, exited 0, and ran nothing there. */
function expectCacheOnly(result: Result, folder: string): void {
  assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.deepStrictEqual(
    parseLines(result.stdout).map((line) => [line.status, line.folder, line.reason]),
    [['skipped', folder, CACHE_ONLY]]
  );
  assert.ok(!existsSync(join(folder, 'apl.marker')), 'nothing ran in the cache');
}

function describeGitScenario(title: string, source: GitSource, steps: { install: AnyStep; update: AnyStep; uninstall: AnyStep }, prefix: string): void {
  describe(title, () => {
    let session: Session;
    let copies: string[] = [];
    const { first, second } = source.pins;
    const whole = source.path === '.';
    const packageName = whole ? source.repo : `${source.repo}/${source.path}`;
    const dependency = (sha: string) => `    - git: ${source.url}.git\n${whole ? '' : `      path: ${source.path}\n`}      ref: ${sha}\n${source.select ? `      skills:\n${source.select.map((name) => `        - ${name}\n`).join('')}` : ''}`;
    const kept = ['.apm', 'apm_modules', ...source.repo.split('/'), ...(whole ? [] : source.path.split('/'))];
    const lock = () => join(session.home, '.apm', 'apm.lock.yaml');
    let cacheOnly = false;
    const cache = () => join(session.home, ...kept);
    const addManifests = async (folders: string[]) => {
      for (const folder of folders) if (!existsSync(join(folder, 'apl.json'))) await writeFile(join(folder, 'apl.json'), GIT_MANIFEST);
    };
    const target = ['--target', source.target];

    before(async function () {
      skipWithoutApm(this);
      const problem = unreachablePins(source);
      if (problem) {
        if (strict) throw new Error(`${problem} (TEST_APM_STRICT=true)`);
        console.log(`      skipping this Git scenario: ${problem}`);
        this.skip();
      }
      session = await openSession(prefix);
      await session.writeUserManifest(dependency(first));
    });
    after(() => {
      if (session) removeAccount(session.root);
    });

    it('install at the old pin: the entry finds no apl.json; with one added to each copy APM deployed, `apl install -g -y` runs it there', async () => {
      session.apm(['install', '-g', ...target]);
      const step = await session.snapshot(steps.install, session.home, lock());
      const row = (parseYaml(step.lock) as { dependencies: Record<string, unknown>[] }).dependencies[0];
      assert.strictEqual(row.host, source.host);
      assert.strictEqual(row.repo_url, source.repo);
      assert.strictEqual(row.resolved_commit, first);
      assert.deepStrictEqual(step.events, ['post-install']);
      assert.match(await session.hookOutput(), /nothing installed/);
      copies = gitCopyFolders(session.home, step.deployed);
      // APM deployed no folder for this package: its cache is the only copy, where no script runs, even with -y
      cacheOnly = !copies.length;
      if (cacheOnly) {
        await addManifests([cache()]);
        expectCacheOnly(session.apl(['install', '-g', '-y']), cache());
        expectCacheOnly(session.apl(['status', '-g']), cache());
        return;
      }
      await addManifests(copies);
      const result = session.apl(['install', '-g', '-y']);
      assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      const ran = parseLines(result.stdout);
      assert.deepStrictEqual(folders(ran), copies);
      assert.ok(ran.every((line) => line.status === 'ran'));
      if (source.skill && whole)
        assert.ok(
          ran.some((line) => line.id === `${source.host}/${source.repo}:skills/${source.skill}`),
          `the skill's copies share one id:\n${result.stdout}`
        );
      for (const copy of copies) assert.strictEqual(await readFile(join(copy, 'apl.marker'), 'utf8'), 'yes');
      assert.strictEqual(session.apl(['status', '-g']).status, 0);
    });

    it(`update (${source.update === 'tag' ? '`apm update` moves the pin to the latest release' : 'the pin is edited to a second commit and `apm install --update` runs'}): the entry runs the scripts that APM left in place for the new revision, and every copy ends ok`, async () => {
      if (source.update === 'tag') session.apm(['update', '-g', '--yes', ...target]);
      else {
        assert.ok(second, 'a pin source needs a second commit');
        await session.writeUserManifest(dependency(second));
        session.apm(['install', '-g', '--update', ...target]);
      }
      const step = await session.snapshot(steps.update, session.home, lock());
      const row = (parseYaml(step.lock) as { dependencies: Record<string, unknown>[] }).dependencies[0];
      assert.notStrictEqual(row.resolved_commit, first, 'the locked commit moved');
      assert.ok(step.events.includes(source.update === 'tag' ? 'post-update' : 'post-install'), `events: ${step.events}`);
      if (cacheOnly) {
        assert.deepStrictEqual(gitCopyFolders(session.home, step.deployed), [], 'APM still deploys no folder for this package');
        await addManifests([cache()]);
        expectCacheOnly(session.apl(['install', '-g']), cache());
        return;
      }
      // the one post-install entry ran apl once: every copy APM left with its apl.json ran for the new revision, and nothing else;
      // a folder APM replaced (obra/superpowers' native plugin) lost the apl.json the test added, as it would with any number of entries
      const kept = gitCopyFolders(session.home, step.deployed).filter((folder) => existsSync(join(folder, 'apl.json')));
      const hook = parseLines(await session.hookOutput());
      assert.deepStrictEqual(
        hook.map((line) => [line.status, line.folder]).sort(),
        kept.map((folder) => ['ran', folder]),
        hook.map((line) => line.text).join('\n')
      );
      copies = gitCopyFolders(session.home, step.deployed);
      await addManifests(copies);
      const result = session.apl(['install', '-g']);
      assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      const status = session.apl(['status', '-g']);
      assert.strictEqual(status.status, 0, `${status.stdout}${status.stderr}`);
      assert.deepStrictEqual(folders(parseLines(status.stdout)), copies);
    });

    it('a quiet update runs no script', async () => {
      if (source.update === 'tag') session.apm(['update', '-g', '--yes', ...target]);
      else session.apm(['install', '-g', ...target]);
      await session.discardEvents();
      const hook = parseLines(await session.hookOutput());
      if (cacheOnly) {
        assert.ok(
          hook.every((line) => line.status === 'skipped' && line.reason === CACHE_ONLY),
          hook.map((line) => line.text).join('\n')
        );
        return;
      }
      // APM fires no entry when nothing changed; whatever an entry printed is current
      assert.ok(
        hook.every((line) => line.status === 'current'),
        hook.map((line) => line.text).join('\n')
      );
      // and apl itself finds every copy, each current
      const again = parseLines(session.apl(['install', '-g']).stdout);
      assert.deepStrictEqual(folders(again), copies);
      assert.ok(
        again.every((line) => line.status === 'current'),
        again.map((line) => line.text).join('\n')
      );
    });

    it('uninstall: `apl status -g` reports `left` for each copy APM kept and exits 0', async () => {
      session.apm(['uninstall', '-g', packageName]);
      const step = await session.snapshot(steps.uninstall, session.home, lock());
      assert.deepStrictEqual(step.events, ['post-uninstall']);
      const status = session.apl(['status', '-g']);
      assert.strictEqual(status.status, 0, `${status.stdout}${status.stderr}`);
      const lines = parseLines(status.stdout);
      assert.deepStrictEqual(
        folders(lines),
        copies.filter((copy) => existsSync(copy))
      );
      assert.ok(lines.every((line) => line.status === 'left'));
    });
  });
}

describeGitScenario('live APM, a plugin in a Git subfolder (anthropics/claude-plugins-official, plugins/commit-commands, no release tags)', GIT_SOURCE, { install: 'git-install', update: 'git-update', uninstall: 'git-uninstall' }, 'apm-live-git');
describeGitScenario('live APM, a plugin at a Git repository root (obra/superpowers, pinned at v7.0.0)', GIT_ROOT_SOURCE, { install: 'gitroot-install', update: 'gitroot-update', uninstall: 'gitroot-uninstall' }, 'apm-live-gitroot');
describeGitScenario('live APM, a plain skill repository (vercel-labs/skills, pinned at v1.2.0, skills: [find-skills])', GIT_SKILLS_SOURCE, { install: 'gitskills-install', update: 'gitskills-update', uninstall: 'gitskills-uninstall' }, 'apm-live-gitskills');

/**
 * A plain skill repository installed for Claude Code at user scope with CLAUDE_CONFIG_DIR moved. APM deploys the skill into that folder
 * and records it in `deployed_files`: as an absolute path outside the home, as a path relative to the home inside it. The copy Claude
 * Code loads is that folder; apl must run there, and never in APM's cache.
 */
function describeClaudeDirScenario(where: 'outside' | 'home'): void {
  const step: ClaudeDirStep = where === 'outside' ? 'claudedir-outside-install' : 'claudedir-home-install';
  const source = GIT_SKILLS_SOURCE;
  describe(`live APM, CLAUDE_CONFIG_DIR ${where === 'outside' ? 'outside the home folder' : 'inside the home folder, not ~/.claude'} (${source.repo}, --target claude)`, () => {
    let session: Session;
    let claudeDir = '';
    before(async function () {
      skipWithoutApm(this);
      const problem = unreachablePins(source);
      if (problem) {
        if (strict) throw new Error(`${problem} (TEST_APM_STRICT=true)`);
        console.log(`      skipping this scenario: ${problem}`);
        this.skip();
      }
      session = await openSession(`apm-live-${step}`, ({ home, outside }) => {
        claudeDir = where === 'outside' ? join(outside, 'claude') : join(home, 'config', 'claude');
        return { CLAUDE_CONFIG_DIR: claudeDir };
      });
      await mkdir(claudeDir, { recursive: true });
      await session.writeUserManifest(`    - git: ${source.url}.git\n      ref: ${source.pins.first}\n      skills:\n${(source.select ?? []).map((name) => `        - ${name}\n`).join('')}`);
    });
    after(() => {
      if (session) removeAccount(session.root);
    });

    it('APM records the skill folder it deployed there; apl runs the script in that folder, the copy Claude Code loads, and reports ok', async () => {
      session.apm(['install', '-g', '--target', 'claude']);
      const recordedStep = await session.snapshot(step, session.home, join(session.home, '.apm', 'apm.lock.yaml'));
      const deployedFiles = (parseYaml(recordedStep.lock) as { dependencies: { deployed_files?: string[] }[] }).dependencies[0].deployed_files ?? [];
      const folder = join(claudeDir, 'skills', source.skill ?? '');
      const recordedFolder = where === 'outside' ? `<OUTSIDE>/claude/skills/${source.skill}` : `config/claude/skills/${source.skill}`;
      assert.ok(deployedFiles.includes(recordedFolder), `deployed_files: ${deployedFiles.join(', ')}`);
      await writeFile(join(folder, 'apl.json'), GIT_MANIFEST);
      const result = session.apl(['install', '-g', '-y']);
      assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.deepStrictEqual(
        parseLines(result.stdout).map((line) => [line.status, line.id, line.folder]),
        [['ran', `${source.host}/${source.repo}:skills/${source.skill}`, folder]]
      );
      assert.strictEqual(await readFile(join(folder, 'apl.marker'), 'utf8'), 'yes');
      const status = session.apl(['status', '-g']);
      assert.strictEqual(status.status, 0, `${status.stdout}${status.stderr}`);
      assert.deepStrictEqual(
        parseLines(status.stdout).map((line) => [line.status, line.folder]),
        [['ok', folder]]
      );
    });
  });
}
describeClaudeDirScenario('outside');
describeClaudeDirScenario('home');

const provenanceOf = (source: GitSource) => ({ url: source.url, path: source.path, skill: source.skill, select: source.select, update: source.update, target: source.target, first: source.pins.first, second: source.pins.second });

describe('live APM recordings', () => {
  it('the lock shapes (field names and types) and the events of each step match the recorded fixtures', async function () {
    if (record || !apm || !recorded.install) return this.skip();
    const dir = await pickRecording(apm.version, osLabel());
    assert.ok(dir, `no recording under ${recordingsRoot}; record one with TEST_APM_RECORD=true (test/README.md)`);
    const fixture = await loadRecording(dir);
    for (const step of ALL_STEPS) {
      const expected = fixture.steps[step];
      if (!recorded[step] || !expected) continue;
      assert.deepStrictEqual(deepShape(parseYaml(recorded[step].lock)), deepShape(parseYaml(expected.lock)), `${step}: apm.lock.yaml shape of apm ${apm.version} on ${osLabel()} changed from the recording in ${dir}; record a new fixture and review src/apm.ts`);
      assert.deepStrictEqual(recorded[step].events, expected.events, `${step}: the events apm ${apm.version} on ${osLabel()} fired changed from the recording in ${dir}; record a new fixture`);
    }
  });

  it('every lock this run saw parses', function () {
    if (!apm || !recorded.install) return this.skip();
    // a user-scope lock may record absolute paths; a project lock may not
    for (const [step, { lock }] of Object.entries(recorded)) if (lock.trim()) assert.doesNotThrow(() => parseLock(parseYaml(lock), !step.startsWith('project-')), step);
  });

  // Runs last: writes what the scenarios above saw. The local scenarios are required; each Git scenario is recorded when it ran.
  it('records the run when TEST_APM_RECORD=true', async function () {
    if (!record || !apm) return this.skip();
    for (const step of [...STEPS, ...PROJECT_STEPS]) assert.ok(recorded[step], `the ${step} step did not run, so there is nothing to record`);
    const dir = join(recordingsRoot, apm.version, osLabel());
    const steps = ALL_STEPS.filter((step) => recorded[step]);
    safeRmSync(dir);
    for (const step of steps) {
      const base = join(dir, 'steps', step);
      await mkdir(base, { recursive: true });
      await writeFile(join(base, 'apm.lock.yaml'), recorded[step].lock);
      await writeFile(join(base, 'deployed.json'), `${JSON.stringify(recorded[step].deployed, null, 2)}\n`);
    }
    await writeFile(join(dir, EVENTS_FILE), `${JSON.stringify(Object.fromEntries(steps.map((step) => [step, recorded[step].events])), null, 2)}\n`);
    const provenance = {
      kind: 'recording of real APM runs; a change detector for the APM lock and the events it fires, not a correctness oracle',
      apm_version: apm.version,
      apm_commit: apm.commit,
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
      claude_dir_source: recorded[CLAUDE_DIR_STEPS[0]] ? { ...provenanceOf(GIT_SKILLS_SOURCE), target: 'claude', claude_config_dir: { outside: '<OUTSIDE>/claude', home: '<HOME>/config/claude' } } : null,
      commands,
      paths: `absolute paths are stored as <HOME> (the recorded account home), <PLUGINS> (the plugin source copy) and <OUTSIDE> (a folder outside the home); project steps are relative to <HOME>/${PROJECT}`,
    };
    await writeFile(join(dir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  });
});
