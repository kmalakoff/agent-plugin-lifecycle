import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'assert';
import { parse as parseYaml } from 'yaml';
import { isUnreadable, type LockedPackage, type LockRow, packageFolders, parseLock, readLock, resolveScope } from '../../src/apm.ts';
import { newestRecording, type Recording, recordedStep, relocate, removeAccount } from '../lib/apm-live.ts';
import { scratch } from '../lib/scratch.ts';

type Lock = { dependencies: Record<string, unknown>[] };
/** Each row, which must be readable. */
function readable(rows: LockRow[]): LockedPackage[] {
  return rows.map((row) => {
    assert.ok(!isUnreadable(row), isUnreadable(row) ? row.reason : '');
    return row;
  });
}
/** The registry row of APM's lockfile spec (reference/lockfile-spec.md, "Top-level structure"): no host, no resolved_commit, no content_hash. */
const SPEC_REGISTRY_ROW = {
  repo_url: 'https://github.com/acme-corp/security-baseline',
  source: 'registry',
  version: '2.1.0',
  resolved_url: 'https://registry.example.com/v1/packages/acme/security-baseline/versions/2.1.0/download',
  resolved_hash: 'sha256:abc123...',
  depth: 1,
  package_type: 'apm_package',
};

describe('parseLock', () => {
  let recording: Recording;
  before(async () => {
    recording = await newestRecording();
  });

  it('reads the local rows APM writes at project scope: an Agent Plugin and a Claude plugin, both with a native copy', () => {
    const rows = readable(parseLock(parseYaml(recordedStep(recording, 'project-install').lock)));
    assert.deepStrictEqual(
      rows.map(({ host, repo, path, localPath, nativePluginRoot }) => ({ host, repo, path, localPath, nativePluginRoot })),
      [
        { host: undefined, repo: '_local/lifecycle-demo', path: '.', localPath: '<PLUGINS>/lifecycle-demo', nativePluginRoot: '.agents/plugins/lifecycle-demo' },
        { host: undefined, repo: '_local/lifecycle-demo-dep', path: '.', localPath: '<PLUGINS>/lifecycle-demo-dep', nativePluginRoot: '.agents/plugins/lifecycle-demo-dep' },
      ]
    );
    for (const row of rows) assert.match(row.revision, /^sha256:[0-9a-f]{64}$/);
  });

  it('reads a Git row: host, repository, revision as commit and content hash, deployed skill files', () => {
    const [row] = readable(parseLock(parseYaml(recordedStep(recording, 'gitskills-install').lock)));
    assert.strictEqual(row.host, 'github.com');
    assert.strictEqual(row.repo, 'vercel-labs/skills');
    assert.strictEqual(row.path, '.');
    assert.match(row.revision, /^[0-9a-f]{40}:sha256:[0-9a-f]{64}$/);
    assert.ok(row.deployedFiles.includes('.agents/skills/find-skills/SKILL.md'));
  });

  it('adds a non-default port to the host, as APM names such a source', () => {
    const lock = parseYaml(recordedStep(recording, 'gitskills-install').lock) as Lock;
    lock.dependencies[0].host = '127.0.0.1';
    lock.dependencies[0].port = 8000;
    assert.strictEqual(readable(parseLock(lock))[0].host, '127.0.0.1:8000');
  });

  it("reads the registry row of APM's spec beside a recorded row: the revision from resolved_hash, the host from the repository URL", () => {
    const lock = parseYaml(recordedStep(recording, 'gitskills-install').lock) as Lock;
    const recorded = readable(parseLock(lock))[0];
    lock.dependencies.push(SPEC_REGISTRY_ROW);
    const [first, registry] = readable(parseLock(lock));
    // the recorded row is read exactly as before
    assert.deepStrictEqual(first, recorded);
    assert.deepStrictEqual(registry, { host: 'github.com', repo: 'acme-corp/security-baseline', path: '.', revision: 'sha256:abc123...', nativePluginRoot: undefined, deployedFiles: [] });
  });

  it('a row apl cannot use for another reason is unreadable alone, named by its repo_url, with its recorded paths; the other rows read', () => {
    const lock = parseYaml(recordedStep(recording, 'gitskills-install').lock) as Lock;
    const original = lock.dependencies[0];
    const unrevised = { ...original };
    delete unrevised.resolved_commit;
    delete unrevised.content_hash;
    (lock.dependencies as unknown[]).push({ ...original, port: '8000', repo_url: 'o/ported' }, unrevised, 3);
    const [kept, ported, none, notObject] = parseLock(lock);
    assert.ok(!isUnreadable(kept));
    assert.deepStrictEqual(ported, { name: 'o/ported', reason: 'APM lock dependencies[1].port must be an integer', nativePluginRoot: undefined, deployedFiles: original.deployed_files });
    assert.deepStrictEqual(isUnreadable(none) && [none.name, none.reason], ['vercel-labs/skills', 'APM lock dependencies[2] has none of resolved_commit, resolved_hash and content_hash']);
    assert.deepStrictEqual(notObject, { name: 'dependencies[3]', reason: 'APM lock dependencies[3] must be an object', deployedFiles: [] });
    const twice = parseYaml(recordedStep(recording, 'gitskills-install').lock) as Lock;
    twice.dependencies.push(twice.dependencies[0]);
    assert.deepStrictEqual(
      parseLock(twice).map((row) => isUnreadable(row) && row.reason),
      [false, 'APM lock dependencies[1] duplicates another lock entry']
    );
  });

  it('a repo_url that names no path (a URL that does not parse, or empty) fails its row alone; the good row reads', () => {
    const lock = parseYaml(recordedStep(recording, 'gitskills-install').lock) as Lock;
    const original = lock.dependencies[0];
    // scp form behind a scheme: the URL parser rejects the port `o`
    lock.dependencies.push({ ...original, repo_url: 'ssh://git@github.com:o/r2' }, { ...original, repo_url: '' });
    const [good, ssh, empty] = parseLock(lock);
    assert.ok(!isUnreadable(good));
    assert.deepStrictEqual(isUnreadable(ssh) && [ssh.name, ssh.reason], ['ssh://git@github.com:o/r2', 'APM lock dependencies[1].repo_url must be a repository path or URL']);
    assert.deepStrictEqual(isUnreadable(empty) && [empty.name, empty.reason], ['dependencies[2]', 'APM lock dependencies[2].repo_url must be a repository path or URL']);
  });

  it('an unsafe path makes the whole lock unreadable, as does a lock without a dependencies array', () => {
    const lock = () => parseYaml(recordedStep(recording, 'gitskills-install').lock) as Lock;
    for (const [field, value] of [
      ['deployed_files', ['../escape']],
      ['deployed_files', ['/abs']],
      ['repo_url', 'a/../b'],
      ['native_plugin', { root: 'C:/x' }],
    ] as const) {
      const bad = lock();
      bad.dependencies[0][field] = value;
      assert.throws(() => parseLock(bad), /unsafe path segment/, `${field}: ${JSON.stringify(value)}`);
    }
    assert.throws(() => parseLock({}), /dependencies must be an array/);
    // a repository URL's path is resolved by the URL parser, so its dot segments cannot leave apm_modules
    const url = lock();
    url.dependencies[0].repo_url = 'https://example.com/a/../../b';
    delete url.dependencies[0].host;
    assert.deepStrictEqual(
      readable(parseLock(url)).map(({ host, repo }) => [host, repo]),
      [['example.com', 'b']]
    );
  });
});

describe('readLock and resolveScope', () => {
  let dir = '';
  before(async () => {
    dir = await scratch('apm');
  });
  after(() => removeAccount(dir));

  it('a missing lock reads as undefined; an unreadable one names the file, and invalid YAML quotes none of it', async () => {
    assert.strictEqual(await readLock(join(dir, 'apm.lock.yaml')), undefined);
    await writeFile(join(dir, 'bad.yaml'), 'dependencies: 3\n');
    await assert.rejects(() => readLock(join(dir, 'bad.yaml')), /^Error: cannot read .*bad\.yaml: APM lock dependencies must be an array/);
    await writeFile(join(dir, 'invalid.yaml'), 'dependencies:\n  - repo_url: [unclosed secret-text\n');
    await assert.rejects(
      () => readLock(join(dir, 'invalid.yaml')),
      (error: Error) => error.message.startsWith(`cannot read ${join(dir, 'invalid.yaml')}: `) && !error.message.includes('secret-text') && !error.message.includes('\n')
    );
  });

  it('the user scope with global or when started in the APM home; otherwise the project in the current folder', async () => {
    const home = join(dir, 'home');
    const apmHome = join(home, '.apm');
    const project = join(dir, 'project');
    await mkdir(apmHome, { recursive: true });
    await mkdir(project);
    const user = { global: true, lock: join(apmHome, 'apm.lock.yaml'), root: home, manifestRoot: apmHome, modules: join(apmHome, 'apm_modules') };
    assert.deepStrictEqual(await resolveScope({ global: true, cwd: project, home, apmHome }), user);
    assert.deepStrictEqual(await resolveScope({ global: false, cwd: apmHome, home, apmHome }), user);
    assert.deepStrictEqual(await resolveScope({ global: false, cwd: project, home, apmHome }), { global: false, lock: join(project, 'apm.lock.yaml'), root: project, manifestRoot: project, modules: join(project, 'apm_modules') });
    assert.strictEqual((await resolveScope({ global: false, cwd: project, home, apmHome: join(dir, 'absent') })).global, false);
  });
});

describe('packageFolders, on recorded locks', () => {
  let recording: Recording;
  let dir = '';
  before(async () => {
    recording = await newestRecording();
    dir = await scratch('apm-folders');
  });
  after(() => removeAccount(dir));
  const home = () => join(dir, 'home');
  const user = () => ({ global: true, lock: join(home(), '.apm', 'apm.lock.yaml'), root: home(), manifestRoot: join(home(), '.apm'), modules: join(home(), '.apm', 'apm_modules') });
  const rows = (lock: string, absolute = true) => readable(parseLock(parseYaml(relocate(lock, { home: home(), plugins: join(dir, 'plugins'), outside: join(dir, 'outside') }, false)), absolute));

  it('each folder APM recorded in deployed_files is a skill copy at skills/<its name>, bounded by the scope root; recorded files are not folders; the cache root no folder carries', async () => {
    const [row] = rows(recordedStep(recording, 'gitskills-install').lock);
    // the cache's own skills/find-skills is carried by the deployed copy; its root is carried by no recorded folder
    assert.deepStrictEqual(await packageFolders(row, user()), {
      folders: [{ folder: join(home(), '.agents', 'skills', 'find-skills'), within: 'skills/find-skills', bound: home() }],
      cache: [{ folder: join(home(), '.apm', 'apm_modules', 'vercel-labs', 'skills'), within: '' }],
    });
  });

  it('a folder APM recorded under a moved CLAUDE_CONFIG_DIR: absolute outside the home (no bound), relative inside it', async () => {
    const outsideStep = recordedStep(recording, 'claudedir-outside-install');
    const [outside] = rows(outsideStep.lock);
    assert.deepStrictEqual((await packageFolders(outside, user())).folders, [{ folder: join(dir, 'outside', 'claude', 'skills', 'find-skills'), within: 'skills/find-skills' }]);
    const [inside] = rows(recordedStep(recording, 'claudedir-home-install').lock);
    assert.deepStrictEqual((await packageFolders(inside, user())).folders, [{ folder: join(home(), 'config', 'claude', 'skills', 'find-skills'), within: 'skills/find-skills', bound: home() }]);
    // the same absolute path is refused in a project lock
    assert.throws(() => rows(outsideStep.lock, false), /deployed_files\[0\] contains an unsafe path segment/);
  });

  it("the native plugin folder and each skills/<name>/ in it, which carry the cache's root and skills; all of the cache when the lock records no folder", async () => {
    const project = join(dir, 'project');
    await mkdir(join(project, '.agents', 'plugins', 'lifecycle-demo', 'skills', 'greet'), { recursive: true });
    await writeFile(join(project, '.agents', 'plugins', 'lifecycle-demo', 'skills', 'README.md'), '');
    const scope = { global: false, lock: join(project, 'apm.lock.yaml'), root: project, manifestRoot: project, modules: join(project, 'apm_modules') };
    const [demo] = rows(recordedStep(recording, 'project-install').lock, false);
    assert.deepStrictEqual(await packageFolders(demo, scope), {
      folders: [
        { folder: join(project, '.agents', 'plugins', 'lifecycle-demo'), within: '', bound: project },
        { folder: join(project, '.agents', 'plugins', 'lifecycle-demo', 'skills', 'greet'), within: 'skills/greet', bound: project },
      ],
      cache: [],
    });
    // commit-commands for copilot: only prompt files are recorded, so the cache is the package's only copy
    const [commands] = rows(recordedStep(recording, 'git-install').lock);
    assert.deepStrictEqual(await packageFolders(commands, user()), {
      folders: [],
      cache: [{ folder: join(home(), '.apm', 'apm_modules', 'anthropics', 'claude-plugins-official', 'plugins', 'commit-commands'), within: '' }],
    });
  });
});
