// Recordings of real APM runs (test/fixtures/apm/<apm-version>/<os>/) replayed through apl: no APM needed, every OS, every run.
// Each step's files and lock are recreated in a disposable home under .tmp/ and apl is run on them as APM's lifecycle entry would.
// A recording is a change detector for APM's lock and deployment, not an oracle for what APM should do.

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import assert from 'assert';
import { safeRmSync } from 'fs-remove-compat';
import { parse as parseYaml } from 'yaml';
import { isUnreadable, parseLock } from '../../src/apm.ts';
import { CACHE_ONLY } from '../../src/constants.ts';
import { install } from '../../src/install.ts';
import { status } from '../../src/status.ts';
import type { CopyResult, Options } from '../../src/types.ts';
import {
  type AnyStep,
  type ClaudeDirStep,
  expectedCopies,
  GIT_MANIFEST,
  gitCopyFolders,
  hashTree,
  isolatedEnvironment,
  listFiles,
  listRecordings,
  loadRecording,
  makeAccount,
  PLUGIN,
  PROJECT,
  placeFiles,
  pluginFixtures,
  type RecordedStep,
  type Recording,
  recordedGitSource,
  recordedStep,
  recordingsRoot,
  relocate,
  removeAccount,
} from '../lib/apm-live.ts';

const yes = async () => true;
const folders = (results: CopyResult[]) => results.map((result) => result.folder).sort();
const statuses = (results: CopyResult[]) => [...new Set(results.map((result) => result.status))].sort();

/** One APM scope in a disposable account, driven through the recorded steps. */
interface Replay {
  scopeRoot: string;
  plugins: string;
  options: Options & { global: boolean };
  /** Recreates the step's files and lock; files of the previous step that the step no longer lists are deleted. */
  apply: (step: RecordedStep) => Promise<void>;
}
async function openReplay(root: string, home: string, plugins: string, user: boolean): Promise<Replay> {
  const scopeRoot = user ? home : join(home, PROJECT);
  const lock = user ? join(home, '.apm', 'apm.lock.yaml') : join(scopeRoot, 'apm.lock.yaml');
  let previous: string[] = [];
  return {
    scopeRoot,
    plugins,
    // with -g apl may be run anywhere; a project is used from its root
    options: { home, cwd: user ? root : scopeRoot, global: user, environment: isolatedEnvironment(home) },
    apply: async (step) => {
      for (const gone of previous.filter((path) => !step.deployed.includes(path))) safeRmSync(join(scopeRoot, ...gone.split('/')));
      previous = step.deployed;
      await placeFiles(scopeRoot, plugins, step.deployed);
      await mkdir(dirname(lock), { recursive: true });
      // APM deletes the lock when the last package is removed
      if (step.lock.trim()) await writeFile(lock, relocate(step.lock, { home, plugins }, false));
      else safeRmSync(lock);
    },
  };
}
/** Removes each folder of which the step lists no file: the recording says APM removed it, whatever the replay itself added there. */
function removeUnlisted(scopeRoot: string, step: RecordedStep, copies: string[]): void {
  const listed = step.deployed.map((path) => join(scopeRoot, ...path.split('/')));
  for (const copy of copies) if (!listed.some((path) => path.startsWith(`${copy}${sep}`))) safeRmSync(copy);
}

async function replayLocal(recording: Recording, user: boolean): Promise<void> {
  const [installStep, updateStep, reinstallStep, uninstallStep] = user ? (['install', 'update', 'reinstall', 'uninstall'] as const) : (['project-install', 'project-update', 'project-reinstall', 'project-uninstall'] as const);
  const step = (name: AnyStep) => recordedStep(recording, name);
  const { root, home, plugins } = await makeAccount(`apm-recorded-${user ? 'user' : 'project'}`);
  try {
    const replay = await openReplay(root, home, plugins, user);
    const { options, scopeRoot } = replay;
    const ofPlugin = (result: CopyResult) => !!result.id && (result.id === join(plugins, PLUGIN) || result.id.startsWith(`${join(plugins, PLUGIN)}:`));

    await replay.apply(step(installStep));
    const copies = expectedCopies(scopeRoot, await listFiles(scopeRoot));
    assert.ok(copies.length >= 3, `the recording deployed apl.json into ${copies.length} copies`);
    // APM's lifecycle entry: no terminal, so nothing is asked
    let results = await install(options);
    assert.deepStrictEqual(folders(results), copies);
    assert.deepStrictEqual(statuses(results), ['unapproved']);
    results = await install({ ...options, approve: yes });
    assert.deepStrictEqual(statuses(results), ['ran']);
    for (const copy of copies) assert.ok(existsSync(join(copy, 'installed.marker')) || existsSync(join(copy, 'setup.done')), `the script ran in ${copy}`);
    assert.deepStrictEqual(statuses(await status(options)), ['ok']);

    await replay.apply(step(updateStep));
    results = await install(options);
    assert.deepStrictEqual(folders(results), copies);
    assert.deepStrictEqual(statuses(results), ['current']);

    await replay.apply(step(reinstallStep));
    results = await install(options);
    assert.deepStrictEqual(folders(results), copies);
    for (const result of results) assert.strictEqual(result.status, ofPlugin(result) ? 'ran' : 'current', `${result.status} ${result.id} ${result.folder}`);
    const before = await status(options);
    assert.deepStrictEqual(statuses(before), ['ok']);

    await replay.apply(step(uninstallStep));
    removeUnlisted(scopeRoot, step(uninstallStep), copies);
    const after = await status(options);
    const kept = before.filter((result) => ofPlugin(result) && existsSync(result.folder));
    assert.deepStrictEqual(folders(after.filter((result) => result.status === 'left')), folders(kept));
    assert.deepStrictEqual(folders(after.filter((result) => result.status === 'ok')), folders(before.filter((result) => !ofPlugin(result))));
    assert.strictEqual(after.length, before.filter((result) => !ofPlugin(result)).length + kept.length);
  } finally {
    removeAccount(root);
  }
}

/** Every copy is APM's cache: install, even approving everything, reports each `skipped` with the reason and runs nothing; status agrees. */
async function expectCacheOnly(options: Options, cache: string[], markers: string[]): Promise<void> {
  assert.ok(cache.length > 0, "the recording has apl.json in APM's cache");
  let asked = 0;
  const results = await install({
    ...options,
    approve: async () => {
      asked++;
      return true;
    },
  });
  assert.deepStrictEqual(folders(results), cache);
  for (const result of [...results, ...(await status(options))]) assert.deepStrictEqual([result.status, result.reason], ['skipped', CACHE_ONLY], result.folder);
  assert.strictEqual(asked, 0, 'nothing is asked for a copy in the cache');
  for (const folder of cache) for (const marker of markers) assert.ok(!existsSync(join(folder, marker)), `nothing ran in ${folder}`);
}

async function replayGit(recording: Recording, kind: 'git' | 'gitroot' | 'gitskills'): Promise<void> {
  const source = recordedGitSource(recording, kind);
  const steps = { install: recordedStep(recording, `${kind}-install`), update: recordedStep(recording, `${kind}-update`), uninstall: recordedStep(recording, `${kind}-uninstall`) };
  const kept = ['.apm', 'apm_modules', ...source.repo.split('/'), ...(source.path === '.' ? [] : source.path.split('/'))];
  const { root, home, plugins } = await makeAccount(`apm-recorded-${kind}`);
  try {
    const replay = await openReplay(root, home, plugins, true);
    const { options } = replay;
    const addManifests = async (copies: string[]) => {
      for (const copy of copies) {
        await mkdir(copy, { recursive: true });
        if (!existsSync(join(copy, 'apl.json'))) await writeFile(join(copy, 'apl.json'), GIT_MANIFEST);
      }
    };

    await replay.apply(steps.install);
    let copies = gitCopyFolders(home, steps.install.deployed);
    // APM deployed no folder for this package (commit-commands for copilot): its cache is the only copy, where no script runs
    if (!copies.length) {
      const cache = [join(home, ...kept)];
      await addManifests(cache);
      await expectCacheOnly(options, cache, ['apl.marker']);
      await replay.apply(steps.update);
      assert.deepStrictEqual(gitCopyFolders(home, steps.update.deployed), []);
      await addManifests(cache);
      await expectCacheOnly(options, cache, ['apl.marker']);
      await replay.apply(steps.uninstall);
      assert.deepStrictEqual(await status(options), []);
      return;
    }
    await addManifests(copies);
    let results = await install({ ...options, approve: yes });
    assert.deepStrictEqual(folders(results), copies);
    assert.deepStrictEqual(statuses(results), ['ran']);
    if (source.skill && source.path === '.') assert.ok(results.some((result) => result.id === `${source.host}/${source.repo}:skills/${source.skill}`));
    assert.deepStrictEqual(statuses(await status(options)), ['ok']);

    // the update moved the locked commit, so every copy runs again without asking
    await replay.apply(steps.update);
    copies = gitCopyFolders(home, steps.update.deployed);
    await addManifests(copies);
    results = await install(options);
    assert.deepStrictEqual(folders(results), copies);
    assert.deepStrictEqual(statuses(results), ['ran']);
    assert.deepStrictEqual(statuses(await status(options)), ['ok']);

    await replay.apply(steps.uninstall);
    removeUnlisted(home, steps.uninstall, copies);
    const after = await status(options);
    assert.deepStrictEqual(
      folders(after),
      copies.filter((copy) => existsSync(copy))
    );
    assert.ok(after.every((result) => result.status === 'left'));
  } finally {
    removeAccount(root);
  }
}

/**
 * A plain skill repository installed for Claude Code with CLAUDE_CONFIG_DIR moved: the lock records the skill folder there (absolute
 * outside the home, relative inside it). The recorded folder is recreated from the lock, an `apl.json` added, and apl must run there.
 */
async function replayClaudeDir(recording: Recording, step: ClaudeDirStep): Promise<void> {
  const recorded = recordedStep(recording, step);
  const source = recordedGitSource(recording, 'gitskills');
  const { root, home, plugins, outside } = await makeAccount(`apm-recorded-${step}`);
  try {
    const lock = relocate(recorded.lock, { home, plugins, outside }, false);
    await mkdir(join(home, '.apm'), { recursive: true });
    await writeFile(join(home, '.apm', 'apm.lock.yaml'), lock);
    const [row] = parseLock(parseYaml(lock), true);
    assert.ok(!isUnreadable(row), 'the recorded row reads');
    const absolute = (path: string) => (isAbsolute(path) ? path : join(home, ...path.split('/')));
    // each recorded file (an entry with nothing recorded under it), with its folders
    for (const file of row.deployedFiles.filter((entry) => !row.deployedFiles.some((other) => other.startsWith(`${entry}/`)))) {
      await mkdir(dirname(absolute(file)), { recursive: true });
      await writeFile(absolute(file), '');
    }
    const folder = step === 'claudedir-outside-install' ? join(outside, 'claude', 'skills', source.skill ?? '') : join(home, 'config', 'claude', 'skills', source.skill ?? '');
    await writeFile(join(folder, 'apl.json'), GIT_MANIFEST);
    const options = { home, cwd: root, global: true, environment: isolatedEnvironment(home) };
    const results = await install({ ...options, approve: yes });
    assert.deepStrictEqual(
      results.map((result) => [result.status, result.id, result.folder]),
      [['ran', `${source.host}/${source.repo}:skills/${source.skill}`, folder]]
    );
    assert.ok(existsSync(join(folder, 'apl.marker')), 'the script ran in the folder APM recorded');
    assert.deepStrictEqual(
      (await status(options)).map((result) => [result.status, result.folder]),
      [['ok', folder]]
    );
  } finally {
    removeAccount(root);
  }
}

describe('recorded APM runs replayed through apl', () => {
  const recordings = listRecordings();
  it('has at least one recording to replay', () => {
    assert.ok(recordings.length > 0, `no recordings under ${recordingsRoot}`);
  });

  for (const dir of recordings) {
    const name = relative(recordingsRoot, dir).split(sep).join('/');
    describe(name, () => {
      let recording: Recording;
      before(async () => {
        recording = await loadRecording(dir);
      });

      it('has provenance and was made from the current test plugins', async () => {
        for (const field of ['apm_version', 'apm_commit', 'os', 'recorded_at', 'environment', 'commands', 'plugin_fixtures_sha256', 'kind']) assert.ok(field in recording.provenance, `provenance.json lacks ${field}`);
        assert.strictEqual(recording.provenance.apm_version, recording.version);
        assert.strictEqual(recording.provenance.plugin_fixtures_sha256, await hashTree(pluginFixtures), 'test/fixtures/plugins changed since this recording; record again (test/README.md)');
      });

      it('every recorded lock parses, every row reads, and each step fired only lifecycle events', () => {
        for (const [step, recorded] of Object.entries(recording.steps) as [string, RecordedStep][]) {
          // a user-scope lock may record absolute paths; a project lock may not
          if (recorded.lock.trim()) for (const row of parseLock(parseYaml(recorded.lock), !step.startsWith('project-'))) assert.ok(!isUnreadable(row), `${step}: ${isUnreadable(row) ? row.reason : ''}`);
          for (const event of recorded.events) assert.ok(['post-install', 'post-update', 'post-uninstall'].includes(event), `${step}: ${event}`);
        }
      });

      it('APM fires post-install, before post-update, on every update that fires post-update, so one post-install entry runs apl on updates', () => {
        const updates = Object.entries(recording.steps).filter(([, recorded]) => recorded?.events.includes('post-update'));
        assert.ok(updates.length > 0, 'the recording has an update that fired post-update');
        for (const [step, recorded] of updates) {
          const events = recorded?.events ?? [];
          assert.ok(events.includes('post-install') && events.indexOf('post-install') < events.indexOf('post-update'), `${step}: ${events.join(', ')}`);
        }
      });

      it('local plugins at user scope: install asks nothing without a terminal, runs once approved, skips current copies, and reports left copies', async () => {
        await replayLocal(recording, true);
      });

      it('local plugins at project scope: the same from the project root', async () => {
        await replayLocal(recording, false);
      });

      for (const [kind, label] of [
        ['git', 'a plugin in a Git subfolder'],
        ['gitroot', 'a plugin at a Git repository root'],
        ['gitskills', 'a plain skill repository'],
      ] as const)
        it(`${label}: apl finds every copy APM deployed, runs it again after the update, and reports left copies after the uninstall`, async () => {
          await replayGit(recording, kind);
        });

      for (const [step, label] of [
        ['claudedir-outside-install', 'outside the home folder'],
        ['claudedir-home-install', 'inside the home folder, not ~/.claude'],
      ] as const)
        it(`CLAUDE_CONFIG_DIR ${label}: apl runs the script in the skill folder APM recorded there, the copy Claude Code loads`, async () => {
          await replayClaudeDir(recording, step);
        });
    });
  }
});
