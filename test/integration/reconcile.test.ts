import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runLifecycle } from 'agent-plugin-lifecycle';
import { safeRmSync } from 'fs-remove-compat';
import { parse as parseYaml, stringify } from 'yaml';
import { listRecordings, loadRecording, makeAccount, PLUGIN, type Recording, recordedGitSource, relocate, removeAccount } from '../lib/apm-live.ts';

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), TMPDIR: join(home, '.tmp'), TMP: join(home, '.tmp'), TEMP: join(home, '.tmp') };
}
function event(eventName: 'post-install' | 'post-update' | 'post-uninstall', packages: { name: string; reference: string | null }[] = []) {
  return { schema_version: 1 as const, event: eventName, scope: 'user' as const, packages };
}
async function fixtureHome(): Promise<string> {
  const scratch = join(process.cwd(), '.tmp');
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, 'plugin-lifecycle-'));
  await mkdir(join(home, '.tmp'));
  return home;
}
/** The lock APM wrote for the Git-sourced test plugin (a real recording), relocated into `home`, and the folder APM keeps that plugin in. */
async function recordedGitInstall(home: string, kind: 'git' | 'gitroot' = 'git'): Promise<{ kept: string; lock: string; source: { url: string; path: string } }> {
  let recording: Recording | undefined;
  for (const dir of listRecordings()) {
    const candidate = await loadRecording(dir);
    if (kind === 'git' ? candidate.gitSteps : candidate.gitRootSteps) recording = candidate;
  }
  const steps = kind === 'git' ? recording?.gitSteps : recording?.gitRootSteps;
  assert.ok(recording && steps, `no recording includes the ${kind} scenario; record one (test/README.md)`);
  const source = recordedGitSource(recording, kind);
  const kept = join(home, '.apm', 'apm_modules', ...source.repo.split('/'), ...(source.path === '.' ? [] : source.path.split('/')));
  await mkdir(kept, { recursive: true });
  const text = relocate((steps as Record<string, { lock: string }>)[`${kind}-install`].lock, { home, plugins: join(home, 'plugins') }, false);
  // APM's native Claude plugin copy, which the lock names and the runner also runs in
  for (const row of (parseYaml(text) as { dependencies: { native_plugin?: { root: string } }[] }).dependencies) if (row.native_plugin) await mkdir(join(home, ...row.native_plugin.root.split('/')), { recursive: true });
  return { source, kept, lock: relocate((steps as Record<string, { lock: string }>)[`${kind}-install`].lock, { home, plugins: join(home, 'plugins') }, false) };
}
describe('APM lifecycle dispatch', () => {
  // Hand-written Git rows stay where no real APM output exists: this one needs several rows from one repository, `native_plugin`
  // and `deployed_files`, which APM 0.37.0 did not write for the Git-sourced test plugin (its recorded lock has neither).
  it('matches Git source/path and skill records, defaults update to install, and checks successful receipts', async () => {
    const home = await fixtureHome();
    try {
      const apmHome = join(home, '.apm');
      const configPath = join(home, '.config', 'agent-plugin-lifecycle', 'config.json');
      const kept = join(apmHome, 'apm_modules', 'org', 'repo');
      const beta = join(kept, 'plugins', 'beta');
      const skill = join(kept, 'skills', 'hello');
      const skillCopy = join(home, '.agents', 'skills', 'hello');
      const nativeRoot = join(home, '.agents', 'plugins', 'repo');
      const nativeSkill = join(nativeRoot, 'skills', 'hello');
      for (const path of [skill, skillCopy, nativeSkill, beta, join(home, '.config', 'agent-plugin-lifecycle')]) await mkdir(path, { recursive: true });
      const source = 'https://example.com/org/repo.git';
      const config = {
        version: 1,
        plugins: [
          { source, 'post-install': "node -e \"require('fs').writeFileSync('installed','yes')\"", 'post-update': "node -e \"require('fs').writeFileSync('updated','yes')\"" },
          { source, skill: 'hello', 'post-install': "node -e \"require('fs').writeFileSync('installed',process.env.HOME)\"" },
          { source, path: 'plugins/beta', 'post-install': "node -e \"require('fs').writeFileSync('installed','yes')\"", 'post-uninstall': "node -e \"require('fs').writeFileSync('cleanup-beta','yes')\"" },
        ],
      };
      await writeFile(configPath, JSON.stringify(config));
      const row = (path: string, files: string[] = []) => ({ host: 'example.com', repo_url: 'org/repo', virtual_path: path, resolved_commit: 'a'.repeat(40), content_hash: `sha256:${'b'.repeat(64)}`, native_plugin: path === '.' ? { root: '.agents/plugins/repo' } : null, deployed_files: files });
      await writeFile(join(apmHome, 'apm.lock.yaml'), stringify({ dependencies: [row('.', ['.agents/skills/hello/SKILL.md']), row('plugins/beta')] }));
      const options = { home, apmHome, configPath, environment: isolatedEnvironment(home), output: () => undefined };
      assert.equal(await runLifecycle('run', { ...options, event: event('post-install') }), 0);
      // the whole-plugin record has a native copy, so APM's kept copy is left alone; so is the kept skill beside its deployed copies
      assert.equal(await readFile(join(nativeRoot, 'installed'), 'utf8'), 'yes');
      await assert.rejects(() => stat(join(kept, 'installed')), { code: 'ENOENT' });
      await assert.rejects(() => stat(join(skill, 'installed')), { code: 'ENOENT' });
      assert.equal(await readFile(join(skillCopy, 'installed'), 'utf8'), home);
      assert.equal(await readFile(join(nativeSkill, 'installed'), 'utf8'), home);
      assert.equal(await readFile(join(beta, 'installed'), 'utf8'), 'yes');
      assert.equal(await runLifecycle('run', { ...options, event: event('post-update') }), 0);
      assert.equal(await readFile(join(nativeRoot, 'updated'), 'utf8'), 'yes');
      assert.equal(await runLifecycle('check', options), 0);

      await writeFile(join(apmHome, 'apm.lock.yaml'), stringify({ dependencies: [row('.', ['.agents/skills/hello/SKILL.md'])] }));
      assert.equal(await runLifecycle('run', { ...options, event: event('post-uninstall', [{ name: 'org/repo', reference: null }]) }), 0);
      assert.equal(await readFile(join(home, 'cleanup-beta'), 'utf8'), 'yes');
      await assert.rejects(() => stat(join(home, 'cleanup-root')), { code: 'ENOENT' });
      assert.equal(await runLifecycle('check', options), 0);
    } finally {
      safeRmSync(home);
    }
  });

  // The event names are the real forms from the Git recording: install and update name a subfolder plugin `owner/repo`, post-uninstall names it `owner/repo/<folder>`.
  it('cleans up only the subfolder Git plugin APM removed when two plugins of one repository are installed', async () => {
    const home = await fixtureHome();
    try {
      const apmHome = join(home, '.apm');
      const configDir = join(home, '.config', 'agent-plugin-lifecycle');
      const configPath = join(configDir, 'config.json');
      const source = 'https://github.com/org/repo';
      const kept = (folder: string) => join(apmHome, 'apm_modules', 'org', 'repo', folder);
      await mkdir(configDir, { recursive: true });
      for (const folder of ['alpha', 'beta']) await mkdir(kept(folder), { recursive: true });
      const cleanup = (folder: string) => `node -e "require('fs').writeFileSync('cleanup-${folder}','ok')"`;
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          plugins: ['alpha', 'beta'].map((folder) => ({ source, path: folder, 'post-install': "node -e \"require('fs').writeFileSync('ready','yes')\"", 'post-uninstall': cleanup(folder) })),
        })
      );
      const row = (folder: string) => ({ host: 'github.com', repo_url: 'org/repo', virtual_path: folder, resolved_commit: 'a'.repeat(40), content_hash: `sha256:${'b'.repeat(64)}`, deployed_files: [] });
      await writeFile(join(apmHome, 'apm.lock.yaml'), stringify({ dependencies: [row('alpha'), row('beta')] }));
      const options = { home, apmHome, configPath, environment: isolatedEnvironment(home), output: () => undefined };
      assert.equal(await runLifecycle('run', { ...options, event: event('post-install', [{ name: 'org/repo', reference: 'a'.repeat(40) }]) }), 0);

      await writeFile(join(apmHome, 'apm.lock.yaml'), stringify({ dependencies: [row('beta')] }));
      assert.equal(await runLifecycle('run', { ...options, event: event('post-uninstall', [{ name: 'org/repo/alpha', reference: null }]) }), 0);
      assert.equal(await readFile(join(home, 'cleanup-alpha'), 'utf8'), 'ok');
      await assert.rejects(() => stat(join(home, 'cleanup-beta')), { code: 'ENOENT' });

      safeRmSync(join(apmHome, 'apm.lock.yaml'));
      assert.equal(await runLifecycle('run', { ...options, event: event('post-uninstall', [{ name: 'org/repo/beta', reference: null }]) }), 0);
      assert.equal(await readFile(join(home, 'cleanup-beta'), 'utf8'), 'ok');
    } finally {
      safeRmSync(home);
    }
  });

  // The Git-sourced install, update and uninstall replay from real APM output is in apm-recorded.test.ts. The local Agent Plugins v1 case
  // below uses the lock from a recording of real APM; the receipt and quoting tests use the recorded Git-sourced lock.
  it('runs local Agent Plugins v1 from the kept skill path and cleans up when APM removes the final lockfile', async () => {
    const recording = await loadRecording(listRecordings()[0]);
    const { root, home, plugins } = await makeAccount('plugin-lifecycle');
    try {
      const locations = { home, plugins };
      const apmHome = join(home, '.apm');
      const source = join(plugins, PLUGIN);
      const kept = join(apmHome, 'apm_modules', '_local', PLUGIN);
      const configDir = join(home, '.config', 'agent-plugin-lifecycle');
      const configPath = join(configDir, 'config.json');
      await mkdir(join(kept, 'skills', 'greet'), { recursive: true });
      await cp(join(source, 'skills', 'greet', 'SKILL.md'), join(kept, 'skills', 'greet', 'SKILL.md'));
      await mkdir(configDir, { recursive: true });
      await writeFile(join(apmHome, 'apm.lock.yaml'), relocate(recording.steps.install.lock, locations, false));
      await writeFile(configPath, JSON.stringify({ version: 1, plugins: [{ source, skill: 'greet', 'post-install': "node -e \"require('fs').writeFileSync('setup.done',process.env.HOME)\"", 'post-uninstall': "node -e \"require('fs').writeFileSync('cleanup.done','ok')\"" }] }));
      const options = { home, apmHome, configPath, environment: isolatedEnvironment(home), output: () => undefined };
      assert.equal(await runLifecycle('run', { ...options, event: event('post-install') }), 0);
      assert.equal(await readFile(join(kept, 'skills', 'greet', 'setup.done'), 'utf8'), home);
      assert.equal(await runLifecycle('check', options), 0);
      safeRmSync(join(apmHome, 'apm.lock.yaml'));
      assert.equal(await runLifecycle('run', { ...options, event: event('post-uninstall', [{ name: `_local/${PLUGIN}`, reference: null }]) }), 0);
      assert.equal(await readFile(join(home, 'cleanup.done'), 'utf8'), 'ok');
      assert.equal(JSON.parse(await readFile(join(configDir, 'state.json'), 'utf8')).receipts && Object.keys(JSON.parse(await readFile(join(configDir, 'state.json'), 'utf8')).receipts).length, 0);
    } finally {
      removeAccount(root);
    }
  });

  it('invalidates an old success receipt before a repeated install/update command can fail', async () => {
    const home = await fixtureHome();
    try {
      const apmHome = join(home, '.apm');
      const configDir = join(home, '.config', 'agent-plugin-lifecycle');
      const configPath = join(configDir, 'config.json');
      const { lock, source } = await recordedGitInstall(home, 'gitroot'); // a whole-repository plugin: its lock row has no virtual_path
      await mkdir(configDir, { recursive: true });
      const command = "node -e \"if(process.env.FAIL_INSTALL==='yes')process.exit(7);require('fs').writeFileSync('ready','yes')\"";
      await writeFile(configPath, JSON.stringify({ version: 1, plugins: [{ source: source.url, 'post-install': command }] }));
      await writeFile(join(apmHome, 'apm.lock.yaml'), lock);
      const environment = isolatedEnvironment(home);
      const options = { home, apmHome, configPath, environment, output: () => undefined };
      assert.equal(await runLifecycle('run', { ...options, event: event('post-install') }), 0);
      assert.equal(await runLifecycle('check', options), 0);
      environment.FAIL_INSTALL = 'yes';
      // nothing changed: the receipt is current and the command does not run again
      assert.equal(await runLifecycle('run', { ...options, event: event('post-update') }), 0);
      assert.equal(await runLifecycle('check', options), 0);
      // a new commit reruns it, and the failure leaves no success receipt behind
      const changed = parseYaml(lock) as { dependencies: { resolved_commit: string }[] };
      changed.dependencies[0].resolved_commit = 'f'.repeat(40);
      await writeFile(join(apmHome, 'apm.lock.yaml'), stringify(changed));
      assert.equal(await runLifecycle('run', { ...options, event: event('post-update') }), 1);
      assert.equal(await runLifecycle('check', options), 1);
    } finally {
      safeRmSync(home);
    }
  });

  // Hand-written on purpose: it covers an SCP-style source on a non-GitHub host (bitbucket.org), which no APM recording has.
  it('retains cleanup receipts after a failed command so a later uninstall event can retry', async () => {
    const home = await fixtureHome();
    try {
      const apmHome = join(home, '.apm');
      const configDir = join(home, '.config', 'agent-plugin-lifecycle');
      const configPath = join(configDir, 'config.json');
      const kept = join(apmHome, 'apm_modules', 'org', 'repo');
      await mkdir(kept, { recursive: true });
      await mkdir(configDir, { recursive: true });
      const source = 'git@bitbucket.org:org/repo.git';
      await writeFile(configPath, JSON.stringify({ version: 1, plugins: [{ source, 'post-install': "node -e \"require('fs').writeFileSync('setup','ok')\"", 'post-uninstall': "node -e \"if(process.env.RETRY_CLEANUP!=='yes')process.exit(5);require('fs').writeFileSync('retry-cleaned','yes')\"" }] }));
      const row = { host: 'bitbucket.org', repo_url: 'org/repo', virtual_path: '.', resolved_commit: 'a'.repeat(40), content_hash: `sha256:${'b'.repeat(64)}`, deployed_files: [] };
      await writeFile(join(apmHome, 'apm.lock.yaml'), stringify({ dependencies: [row] }));
      const environment = isolatedEnvironment(home);
      const options = { home, apmHome, configPath, environment, output: () => undefined };
      assert.equal(await runLifecycle('run', { ...options, event: event('post-install') }), 0);
      safeRmSync(join(apmHome, 'apm.lock.yaml'));
      const removed = event('post-uninstall', [{ name: 'org/repo', reference: null }]);
      assert.equal(await runLifecycle('run', { ...options, event: removed }), 1);
      assert.ok(Object.keys(JSON.parse(await readFile(join(configDir, 'state.json'), 'utf8')).receipts).length > 0);
      environment.RETRY_CLEANUP = 'yes';
      assert.equal(await runLifecycle('run', { ...options, event: removed }), 0);
      assert.equal(await readFile(join(home, 'retry-cleaned'), 'utf8'), 'yes');
      assert.equal(Object.keys(JSON.parse(await readFile(join(configDir, 'state.json'), 'utf8')).receipts).length, 0);
    } finally {
      safeRmSync(home);
    }
  });
  it('runs a command string with spaces, double quotes and single quotes exactly as written', async () => {
    const home = await fixtureHome();
    try {
      const apmHome = join(home, '.apm');
      const configDir = join(home, '.config', 'agent-plugin-lifecycle');
      const configPath = join(configDir, 'config.json');
      const { kept, lock, source } = await recordedGitInstall(home);
      await mkdir(configDir, { recursive: true });
      const command = "node -e \"require('fs').writeFileSync('quoted name.txt', 'say \\\"hi\\\" it is')\"";
      await writeFile(configPath, JSON.stringify({ version: 1, plugins: [{ source: source.url, path: source.path, 'post-install': command }] }));
      await writeFile(join(apmHome, 'apm.lock.yaml'), lock);
      const options = { home, apmHome, configPath, environment: isolatedEnvironment(home), output: () => undefined };
      assert.equal(await runLifecycle('run', { ...options, event: event('post-install') }), 0);
      assert.equal(await readFile(join(kept, 'quoted name.txt'), 'utf8'), 'say "hi" it is');
    } finally {
      safeRmSync(home);
    }
  });
});

// Receipts (digest + revision), the kept-copy rule and `check` statuses, against a hand-written lock: the shapes needed here
// (`native_plugin`, `deployed_files`, a moving commit) are not in any recording.
describe('receipts, copies and check statuses', () => {
  const source = 'https://example.com/org/repo.git';
  const log = "node -e \"require('fs').appendFileSync('runs.log','x')\"";
  const runs = async (dir: string): Promise<number> => {
    try {
      return (await readFile(join(dir, 'runs.log'), 'utf8')).length;
    } catch {
      return 0;
    }
  };
  interface Setup {
    home: string;
    apmHome: string;
    configPath: string;
    configDir: string;
    lines: string[];
    options: { home: string; apmHome: string; configPath: string; environment: NodeJS.ProcessEnv; output: (line: string) => void };
    lock(commit?: string, native?: boolean, files?: string[]): Promise<void>;
    config(plugin: Record<string, unknown>): Promise<void>;
    kept: string;
    native: string;
  }
  async function setup(): Promise<Setup> {
    const home = await fixtureHome();
    const apmHome = join(home, '.apm');
    const configDir = join(home, '.config', 'agent-plugin-lifecycle');
    const configPath = join(configDir, 'config.json');
    await mkdir(configDir, { recursive: true });
    const lines: string[] = [];
    return {
      home,
      apmHome,
      configPath,
      configDir,
      lines,
      options: { home, apmHome, configPath, environment: isolatedEnvironment(home), output: (line: string) => void lines.push(line) },
      kept: join(apmHome, 'apm_modules', 'org', 'repo'),
      native: join(home, '.agents', 'plugins', 'repo'),
      async lock(commit = 'a', native = true, files: string[] = []) {
        const row = { host: 'example.com', repo_url: 'org/repo', virtual_path: '.', resolved_commit: commit.repeat(40), content_hash: `sha256:${'b'.repeat(64)}`, native_plugin: native ? { root: '.agents/plugins/repo' } : null, deployed_files: files };
        await mkdir(apmHome, { recursive: true });
        await writeFile(join(apmHome, 'apm.lock.yaml'), stringify({ dependencies: [row] }));
      },
      async config(plugin) {
        await writeFile(configPath, JSON.stringify({ version: 1, plugins: [{ source, ...plugin }] }));
      },
    };
  }

  it("runs in APM's kept copy only when no other copy exists", async () => {
    const t = await setup();
    try {
      await mkdir(t.kept, { recursive: true });
      await mkdir(t.native, { recursive: true });
      await t.config({ 'post-install': log });
      await t.lock('a', true);
      assert.equal(await runLifecycle('run', { ...t.options, event: event('post-install') }), 0);
      assert.equal(await runs(t.native), 1);
      assert.equal(await runs(t.kept), 0, "the kept copy is APM's cache when a native copy exists");

      // the skill record: kept skill + deployed copies -> deployed copies only; kept skill alone -> kept skill
      const keptSkill = join(t.kept, 'skills', 'hello');
      const claudeSkill = join(t.home, '.claude', 'skills', 'hello');
      await mkdir(keptSkill, { recursive: true });
      await mkdir(claudeSkill, { recursive: true });
      await t.config({ skill: 'hello', 'post-install': log });
      await t.lock('a', false, ['.claude/skills/hello/SKILL.md']);
      assert.equal(await runLifecycle('run', { ...t.options, event: event('post-install') }), 0);
      assert.equal(await runs(claudeSkill), 1);
      assert.equal(await runs(keptSkill), 0);

      await t.lock('a', false, []);
      assert.equal(await runLifecycle('run', { ...t.options, event: event('post-install') }), 0);
      assert.equal(await runs(keptSkill), 1, 'the kept skill is the only copy');

      const alone = await setup();
      try {
        await mkdir(alone.kept, { recursive: true });
        await alone.config({ 'post-install': log });
        await alone.lock('a', false);
        assert.equal(await runLifecycle('run', { ...alone.options, event: event('post-install') }), 0);
        assert.equal(await runs(alone.kept), 1, 'the kept plugin copy is the only copy');
      } finally {
        safeRmSync(alone.home);
      }
    } finally {
      safeRmSync(t.home);
    }
  });

  it('skips a copy whose receipt matches the command and revision, and reruns when either changes or the copy was removed', async () => {
    const t = await setup();
    try {
      const other = join(t.home, '.claude', 'skills', 'hello');
      const agents = join(t.home, '.agents', 'skills', 'hello');
      for (const dir of [other, agents]) await mkdir(dir, { recursive: true });
      const files = ['.claude/skills/hello/SKILL.md', '.agents/skills/hello/SKILL.md'];
      await t.config({ skill: 'hello', 'post-install': log });
      await t.lock('a', false, files);
      const fire = (name: 'post-install' | 'post-update' = 'post-install') => runLifecycle('run', { ...t.options, event: event(name) });
      assert.equal(await fire(), 0);
      assert.equal(await runs(other), 1);
      t.lines.length = 0;
      assert.equal(await fire('post-update'), 0); // the second event of one APM run: nothing changed
      assert.equal(await runs(other), 1);
      assert.equal(await runs(agents), 1);
      assert.deepEqual(
        t.lines.map((line) => line.split(' ')[0]),
        ['current', 'current']
      );

      await t.lock('c', false, files); // a new commit
      assert.equal(await fire(), 0);
      assert.equal(await runs(other), 2);

      await t.config({ skill: 'hello', 'post-install': `${log} && echo` }); // a changed command
      assert.equal(await fire(), 0);
      assert.equal(await runs(other), 3);
      assert.equal(await fire(), 0);
      assert.equal(await runs(other), 3);

      safeRmSync(other); // a removed copy loses its receipt; APM recreates it empty and the next run fills it
      assert.equal(await fire(), 0);
      assert.equal(await runs(agents), 3);
      await mkdir(other, { recursive: true });
      assert.equal(await fire(), 0);
      assert.equal(await runs(other), 1);
      assert.equal(await runs(agents), 3);
    } finally {
      safeRmSync(t.home);
    }
  });

  it('reads a version 1 state, reruns each copy once and saves version 2 receipts with the revision', async () => {
    const t = await setup();
    try {
      await mkdir(t.native, { recursive: true });
      await t.config({ 'post-install': log });
      await t.lock();
      const fire = () => runLifecycle('run', { ...t.options, event: event('post-install') });
      assert.equal(await fire(), 0);
      const statePath = join(t.configDir, 'state.json');
      const v2 = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(v2.version, 2);
      const [[key, receipt]] = Object.entries(v2.receipts) as [string, { digest: string; revision: string }][];
      assert.equal(receipt.revision, `${'a'.repeat(40)}:sha256:${'b'.repeat(64)}`);
      await writeFile(statePath, JSON.stringify({ version: 1, receipts: { [key]: receipt.digest } }));
      assert.equal(await runLifecycle('check', t.options), 1, 'a version 1 receipt has an unknown revision');
      assert.equal(await fire(), 0);
      assert.equal(await runs(t.native), 2);
      assert.equal(JSON.parse(await readFile(statePath, 'utf8')).version, 2);
      assert.equal(await fire(), 0);
      assert.equal(await runs(t.native), 2);
    } finally {
      safeRmSync(t.home);
    }
  });

  it('check says ok, missing, stale or broken per copy, and nothing installed without lock rows', async () => {
    const t = await setup();
    try {
      await mkdir(t.native, { recursive: true });
      await t.config({ 'post-install': log });
      assert.equal(await runLifecycle('check', t.options), 0);
      assert.deepEqual(t.lines, ['nothing installed']);

      await t.lock();
      t.lines.length = 0;
      assert.equal(await runLifecycle('check', t.options), 1);
      assert.deepEqual(t.lines, [`missing ${JSON.stringify([source, '.', null])} ${await realpath(t.native)}`]);

      assert.equal(await runLifecycle('run', { ...t.options, event: event('post-install') }), 0);
      const status = async (): Promise<[number, string]> => {
        t.lines.length = 0;
        const code = await runLifecycle('check', t.options);
        return [code, t.lines[0].split(' ')[0]];
      };
      assert.deepEqual(await status(), [0, 'ok']);

      await t.lock('c');
      assert.deepEqual(await status(), [1, 'stale']);
      assert.equal(await runLifecycle('run', { ...t.options, event: event('post-update') }), 0);
      assert.deepEqual(await status(), [0, 'ok']);

      await t.config({ 'post-install': `${log} && echo` });
      assert.deepEqual(await status(), [1, 'stale']);
      await t.config({ 'post-install': log });
      assert.deepEqual(await status(), [0, 'ok']);

      safeRmSync(t.native);
      assert.deepEqual(await status(), [1, 'broken']);

      safeRmSync(join(t.apmHome, 'apm.lock.yaml'));
      t.lines.length = 0;
      assert.equal(await runLifecycle('check', t.options), 0);
      assert.deepEqual(t.lines, ['nothing installed']);

      await writeFile(join(t.apmHome, 'apm.lock.yaml'), stringify({ dependencies: [] }));
      t.lines.length = 0;
      assert.equal(await runLifecycle('check', t.options), 0);
      assert.deepEqual(t.lines, ['nothing installed']);
    } finally {
      safeRmSync(t.home);
    }
  });

  it('prints left for each copy that still exists before the post-uninstall command, and deletes nothing', async () => {
    const t = await setup();
    try {
      const other = join(t.home, '.claude', 'skills', 'hello');
      const agents = join(t.home, '.agents', 'skills', 'hello');
      for (const dir of [other, agents]) await mkdir(dir, { recursive: true });
      await t.config({ skill: 'hello', 'post-install': log, 'post-uninstall': "node -e \"require('fs').writeFileSync('cleanup.done','ok')\"" });
      await t.lock('a', false, ['.claude/skills/hello/SKILL.md', '.agents/skills/hello/SKILL.md']);
      assert.equal(await runLifecycle('run', { ...t.options, event: event('post-install') }), 0);
      await writeFile(join(other, 'mine.txt'), 'user file');
      safeRmSync(agents); // APM removed this one; the other is kept because it holds a file APM did not write
      safeRmSync(join(t.apmHome, 'apm.lock.yaml'));
      t.lines.length = 0;
      assert.equal(await runLifecycle('run', { ...t.options, event: event('post-uninstall', [{ name: 'org/repo', reference: null }]) }), 0);
      assert.deepEqual(t.lines, [`left ${await realpath(other)}`, `cleaned ${JSON.stringify([source, '.', 'hello'])}`]);
      assert.equal(await readFile(join(other, 'mine.txt'), 'utf8'), 'user file');
      assert.equal(await runs(other), 1);
      assert.equal(await readFile(join(t.home, 'cleanup.done'), 'utf8'), 'ok');
    } finally {
      safeRmSync(t.home);
    }
  });

  it('never uses the kept copy when the lock names another copy that is missing on disk', async () => {
    const t = await setup();
    try {
      await mkdir(join(t.kept, 'skills', 'hello'), { recursive: true });
      await mkdir(t.kept, { recursive: true });
      await t.config({ skill: 'hello', 'post-install': log });
      await t.lock('a', false, ['.claude/skills/hello/SKILL.md']); // listed, not on disk
      assert.equal(await runLifecycle('run', { ...t.options, event: event('post-install') }), 1);
      assert.equal(await runs(join(t.kept, 'skills', 'hello')), 0);
      assert.equal(await runLifecycle('check', t.options), 1);

      await t.config({ 'post-install': log });
      await t.lock('a', true); // native root listed, not on disk
      t.lines.length = 0;
      assert.equal(await runLifecycle('run', { ...t.options, event: event('post-install') }), 1);
      assert.equal(await runs(t.kept), 0);
      assert.equal(await runLifecycle('check', t.options), 1);
    } finally {
      safeRmSync(t.home);
    }
  });
});
