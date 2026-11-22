// Package tests driven by recordings of real APM runs (test/fixtures/apm/<apm-version>/<os>/): no APM needed, every OS, every run.
// A recording is a change detector for APM's lock and event schema, not an oracle for what APM should do. Each recording is
// relocated into a disposable home under .tmp/ and replayed through the runner exactly as APM delivered it.
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { type LifecycleEvent, parseLock, runLifecycle } from 'agent-plugin-lifecycle';
import { safeRmSync } from 'fs-remove-compat';
import { parse as parseYaml } from 'yaml';
import { DEPENDENCY, gitLifecycleConfig, hashTree, isolatedEnvironment, lifecycleConfig, listRecordings, loadRecording, makeAccount, PLUGIN, pluginFixtures, type RecordedStep, type Recording, recordedGitSource, recordingsRoot, relocate, removeAccount } from '../lib/apm-live.ts';

const KEPT = /^\.apm\/apm_modules\/_local\/([^/]+)\/(.+)$/;
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  );

async function placeFiles(home: string, plugins: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    const target = join(home, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    const kept = KEPT.exec(path);
    if (kept && (await exists(join(plugins, kept[1], ...kept[2].split('/'))))) await copyFile(join(plugins, kept[1], ...kept[2].split('/')), target);
    else await writeFile(target, '');
  }
}

describe('recorded APM runs replayed through the runner', () => {
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

      it('has provenance for the APM version, OS and plugin the recording was made from', async () => {
        for (const field of ['apm_version', 'apm_commit', 'os', 'recorded_at', 'environment', 'commands', 'plugin_fixtures_sha256', 'kind']) assert.ok(field in recording.provenance, `provenance.json lacks ${field}`);
        assert.equal(recording.provenance.apm_version, recording.version);
        assert.equal(recording.provenance.plugin_fixtures_sha256, await hashTree(pluginFixtures), 'test/fixtures/plugins changed since this recording; record again');
      });

      it('every recorded lock parses and every recorded event is the shape the runner reads', () => {
        const steps: [string, RecordedStep][] = [...Object.entries(recording.steps), ...Object.entries(recording.gitSteps ?? {}), ...Object.entries(recording.gitRootSteps ?? {})];
        for (const [step, recorded] of steps) {
          if (!recorded.lock.trim()) continue; // APM deletes the lock when the last package is removed
          const rows = parseLock(parseYaml(recorded.lock));
          for (const row of rows) {
            if (step.startsWith('git')) {
              const expected = recordedGitSource(recording, step.startsWith('gitroot-') ? 'gitroot' : 'git');
              assert.ok(row.host === expected.host && row.repo === expected.repo && row.path === expected.path && !row.localPath, `${step}: expected the Git-sourced Agent Plugin row`);
            } else assert.ok(row.localPath && row.repo.startsWith('_local/'), `${step}: expected local Agent Plugin rows`);
          }
          for (const { payload } of recorded.events) {
            const event = JSON.parse(payload);
            assert.equal(event.schema_version, 1);
            assert.equal(event.scope, 'user');
            assert.ok(['post-install', 'post-update', 'post-uninstall'].includes(event.event));
            assert.ok(Array.isArray(event.packages) && event.packages.every((item: { name: unknown; reference: unknown }) => typeof item.name === 'string' && (item.reference === null || typeof item.reference === 'string')));
          }
        }
      });

      it('runs install, update, reinstall and uninstall from the recorded locks and events', async () => {
        const { root, home, plugins } = await makeAccount('apm-recorded');
        try {
          const locations = { home, plugins };
          const apmHome = join(home, '.apm');
          const configDir = join(home, '.config', 'agent-plugin-lifecycle');
          const configPath = join(configDir, 'config.json');
          await mkdir(configDir, { recursive: true });
          await writeFile(configPath, JSON.stringify(lifecycleConfig(plugins)));
          const options = { home, apmHome, configPath, environment: isolatedEnvironment(home), output: () => undefined };
          const lock = (step: RecordedStep) => writeFile(join(apmHome, 'apm.lock.yaml'), relocate(step.lock, locations, false));
          const fire = async (step: RecordedStep) => {
            for (const { payload } of step.events) assert.equal(await runLifecycle('run', { ...options, event: JSON.parse(relocate(payload, locations, true)) as LifecycleEvent }), 0);
          };
          const kept = (plugin: string, ...rest: string[]) => join(apmHome, 'apm_modules', '_local', plugin, ...rest);

          await placeFiles(home, plugins, recording.steps.install.deployed);
          await lock(recording.steps.install);
          await fire(recording.steps.install);
          assert.equal(await readFile(kept(PLUGIN, 'skills', 'greet', 'setup.done'), 'utf8'), home);
          assert.equal(await readFile(kept(DEPENDENCY, 'skills', 'shout', 'setup.done'), 'utf8'), home);
          assert.equal(await readFile(kept(PLUGIN, 'installed.marker'), 'utf8'), 'yes');
          assert.equal(await runLifecycle('check', options), 0);

          await lock(recording.steps.update);
          await fire(recording.steps.update);
          assert.equal(await runLifecycle('check', options), 0);

          safeRmSync(kept(PLUGIN, 'skills', 'greet', 'setup.done'));
          await lock(recording.steps.reinstall);
          await fire(recording.steps.reinstall);
          assert.equal(await readFile(kept(PLUGIN, 'skills', 'greet', 'setup.done'), 'utf8'), home);
          assert.equal(await runLifecycle('check', options), 0);

          for (const gone of recording.steps.install.deployed.filter((path) => !recording.steps.uninstall.deployed.includes(path))) safeRmSync(join(home, ...gone.split('/')));
          safeRmSync(kept(PLUGIN));
          await lock(recording.steps.uninstall);
          await fire(recording.steps.uninstall);
          assert.equal(await readFile(join(home, 'cleanup.done'), 'utf8'), 'ok');
          assert.equal(await runLifecycle('check', options), 0);
        } finally {
          removeAccount(root);
        }
      });

      for (const [kind, label] of [
        ['git', 'subfolder'],
        ['gitroot', 'whole-repository'],
      ] as const)
        it(`runs the Git-sourced ${label} install, update and uninstall from the recorded locks and events`, async function () {
          const recordedSteps = (kind === 'git' ? recording.gitSteps : recording.gitRootSteps) as Record<string, RecordedStep> | undefined;
          const gitSteps = recordedSteps;
          if (!gitSteps) return this.skip(); // this recording predates the Git scenario; re-record it (README)
          const source = recordedGitSource(recording, kind);
          const { root, home, plugins } = await makeAccount(`apm-recorded-${kind}`);
          try {
            const locations = { home, plugins };
            const apmHome = join(home, '.apm');
            const configDir = join(home, '.config', 'agent-plugin-lifecycle');
            const configPath = join(configDir, 'config.json');
            await mkdir(configDir, { recursive: true });
            await writeFile(configPath, JSON.stringify(gitLifecycleConfig(source)));
            const options = { home, apmHome, configPath, environment: isolatedEnvironment(home), output: () => undefined };
            const lock = (step: RecordedStep) => writeFile(join(apmHome, 'apm.lock.yaml'), relocate(step.lock, locations, false));
            const fire = async (step: RecordedStep) => {
              for (const { payload } of step.events) assert.equal(await runLifecycle('run', { ...options, event: JSON.parse(relocate(payload, locations, true)) as LifecycleEvent }), 0);
            };
            const kept = (...rest: string[]) => join(apmHome, 'apm_modules', ...source.repo.split('/'), ...source.path.split('/'), ...rest);

            await placeFiles(home, plugins, gitSteps[`${kind}-install`].deployed);
            await lock(gitSteps[`${kind}-install`]);
            await fire(gitSteps[`${kind}-install`]);
            assert.equal(await readFile(kept('installed.marker'), 'utf8'), 'yes');
            assert.equal(await readFile(kept('skills', 'greet', 'setup.done'), 'utf8'), home);
            assert.equal(await runLifecycle('check', options), 0);

            // APM sends post-install and then post-update for a moved pin; post-update has its own commands in the policy
            await lock(gitSteps[`${kind}-update`]);
            await fire(gitSteps[`${kind}-update`]);
            assert.equal(await readFile(kept('updated.marker'), 'utf8'), 'yes');
            assert.equal(await readFile(kept('skills', 'greet', 'setup.updated'), 'utf8'), home);
            assert.equal(await runLifecycle('check', options), 0);

            for (const gone of gitSteps[`${kind}-update`].deployed.filter((path) => !gitSteps[`${kind}-uninstall`].deployed.includes(path))) safeRmSync(join(home, ...gone.split('/')));
            assert.equal(gitSteps[`${kind}-uninstall`].lock.trim(), '', 'APM deletes the lock when the last package is removed');
            safeRmSync(join(apmHome, 'apm.lock.yaml'));
            assert.equal(await runLifecycle('run', { ...options, event: JSON.parse(relocate(gitSteps[`${kind}-uninstall`].events[0].payload, locations, true)) as LifecycleEvent }), 0);
            assert.equal(await readFile(join(home, 'cleanup.done'), 'utf8'), 'ok');
          } finally {
            removeAccount(root);
          }
        });
    });
  }
});
