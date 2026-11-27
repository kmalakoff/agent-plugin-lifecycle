import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'assert';
import { parse as parseYaml, stringify } from 'yaml';
import { CACHE_ONLY, NO_PROJECT_LOCK } from '../../src/constants.ts';
import { copyId, findCopies, packageId } from '../../src/copies.ts';
import { GIT_MANIFEST, makeAccount, newestRecording, PROJECT, placeStep, recordedStep, removeAccount } from '../lib/apm-live.ts';
import { scratch } from '../lib/scratch.ts';

describe('packageId and copyId', () => {
  const git = { host: 'github.com', repo: 'vercel-labs/skills', path: '.', revision: 'r', deployedFiles: [] };

  it('a Git package is host/repo, then /path for a plugin in a subfolder, then :folder below the package root', () => {
    assert.strictEqual(copyId(packageId(git, '/p'), 'skills/find-skills'), 'github.com/vercel-labs/skills:skills/find-skills');
    assert.strictEqual(copyId(packageId({ ...git, repo: 'anthropics/plugins', path: 'plugins/commit' }, '/p'), ''), 'github.com/anthropics/plugins/plugins/commit');
    assert.strictEqual(packageId({ ...git, host: '127.0.0.1:8000' }, '/p'), '127.0.0.1:8000/vercel-labs/skills');
  });

  it('a local package is its absolute source path, a relative one resolved from the folder holding apm.yml', () => {
    const local = { repo: '_local/demo', path: '.', revision: 'r', deployedFiles: [] };
    assert.strictEqual(copyId(packageId({ ...local, localPath: resolve('/src/demo') }, '/p'), 'skills/hello'), `${resolve('/src/demo')}:skills/hello`);
    assert.strictEqual(packageId({ ...local, localPath: './plugins/demo' }, resolve('/project')), resolve('/project/plugins/demo'));
  });
});

describe('findCopies with named folders', () => {
  let dir = '';
  before(async () => {
    dir = await scratch('copies');
  });
  after(() => removeAccount(dir));
  const options = () => ({ home: join(dir, 'home'), apmHome: join(dir, 'home', '.apm'), cwd: dir, global: false });

  it('a folder is its own real path as id and place; one without apl.json, without scripts.install, or missing is failed', async () => {
    for (const name of ['good', 'empty', 'none', 'bad']) await mkdir(join(dir, name));
    await writeFile(join(dir, 'good', 'apl.json'), '{"scripts":{"install":"node x.js"}}');
    await writeFile(join(dir, 'empty', 'apl.json'), '{"scripts":{}}');
    await writeFile(join(dir, 'bad', 'apl.json'), '[]');
    const real = await realpath(dir);
    const { copies } = await findCopies({ ...options(), folders: ['good', 'empty', 'none', 'bad', 'gone'] });
    assert.deepStrictEqual(copies, [
      { id: join(real, 'good'), folder: join(real, 'good'), place: join(real, 'good'), install: 'node x.js' },
      // a misspelt or absent key in a folder the author named is a mistake to report, not a folder with nothing to run
      { id: join(real, 'empty'), folder: join(real, 'empty'), place: join(real, 'empty'), error: 'apl.json has no scripts.install' },
      { id: join(real, 'none'), folder: join(real, 'none'), place: join(real, 'none'), error: 'no apl.json' },
      { id: join(real, 'bad'), folder: join(real, 'bad'), place: join(real, 'bad'), error: 'apl.json must be an object' },
      { id: join(dir, 'gone'), folder: join(dir, 'gone'), place: join(dir, 'gone'), error: 'no apl.json' },
    ]);
  });

  it('a folder named more than once, also through a link, is one copy', async () => {
    const real = await realpath(dir);
    await symlink(join(real, 'good'), join(dir, 'link-to-good'), 'junction');
    const { copies } = await findCopies({ ...options(), folders: ['good', './good', join(real, 'good'), 'link-to-good'] });
    assert.deepStrictEqual(
      copies.map((copy) => copy.folder),
      [join(real, 'good')]
    );
  });

  it('-g cannot be combined with folders; with neither, the current folder must hold an apm.lock.yaml', async () => {
    await assert.rejects(() => findCopies({ ...options(), global: true, folders: ['good'] }), /-g cannot be combined with folders/);
    await assert.rejects(() => findCopies(options()), new RegExp(NO_PROJECT_LOCK));
    assert.deepStrictEqual((await findCopies({ ...options(), global: true })).copies, []);
  });
});

/** The recorded project lock with lifecycle-demo's native plugin removed, so APM's cache under apm_modules is its only copy. */
async function cacheOnlyProject(prefix: string) {
  const recording = await newestRecording();
  const step = recordedStep(recording, 'project-install');
  const account = await makeAccount(prefix);
  const lock = parseYaml(step.lock) as { dependencies: { repo_url: string; native_plugin?: unknown }[] };
  const row = lock.dependencies.find((item) => item.repo_url === '_local/lifecycle-demo');
  assert.ok(row?.native_plugin, 'the recording deploys lifecycle-demo as a native plugin');
  delete row.native_plugin;
  const project = join(account.home, PROJECT);
  await placeStep(step, project, join(project, 'apm.lock.yaml'), account, stringify(lock));
  const cache = join(project, 'apm_modules', '_local', 'lifecycle-demo');
  assert.ok(existsSync(join(cache, 'apl.json')), 'the recording caches lifecycle-demo with its apl.json');
  return { account, project, cache, options: { home: account.home, apmHome: join(account.home, '.apm'), cwd: project, global: false } };
}

describe('findCopies from a recorded project lock', () => {
  let root = '';
  let project = '';
  before(async () => {
    const recording = await newestRecording();
    const account = await makeAccount('copies-project');
    root = account.root;
    project = join(account.home, PROJECT);
    const step = recordedStep(recording, 'project-install');
    await placeStep(step, project, join(project, 'apm.lock.yaml'), account);
  });
  after(() => removeAccount(root));
  const options = () => ({ home: join(root, 'home'), apmHome: join(root, 'home', '.apm'), cwd: project, global: false });

  it('every copy has the real path of the project folder as its place, also when apl runs through a link to it', async () => {
    const link = join(root, 'project-link');
    await symlink(project, link, 'junction');
    const { copies } = await findCopies({ home: join(root, 'home'), apmHome: join(root, 'home', '.apm'), cwd: link, global: false });
    assert.ok(copies.length > 0);
    const real = await realpath(project);
    for (const copy of copies) assert.strictEqual(copy.place, real, copy.folder);
  });

  it("a package whose only copy is APM's cache is skipped with that reason, and its apl.json is never read", async () => {
    const { account, project: other, cache, options } = await cacheOnlyProject('copies-cache-only');
    try {
      const only = async () => (await findCopies(options)).copies.filter((copy) => copy.folder.startsWith(join(other, 'apm_modules')));
      assert.deepStrictEqual(
        (await only()).map(({ id, folder, install, skipped }) => ({ id, folder, install, skipped })),
        [
          { id: join(account.plugins, 'lifecycle-demo'), folder: cache, install: undefined, skipped: CACHE_ONLY },
          { id: `${join(account.plugins, 'lifecycle-demo')}:skills/greet`, folder: join(cache, 'skills', 'greet'), install: undefined, skipped: CACHE_ONLY },
        ]
      );
      // not read: an invalid file, or a link to a file outside the project, gives the same line and prints none of the file
      await writeFile(join(cache, 'apl.json'), '{ not json');
      assert.deepStrictEqual(
        (await only()).map((copy) => copy.skipped),
        [CACHE_ONLY, CACHE_ONLY]
      );
      const npmrc = join(account.root, 'npmrc');
      await writeFile(npmrc, '//registry.example/:_authToken=secret\n');
      removeAccount(join(cache, 'apl.json'));
      await symlink(npmrc, join(cache, 'apl.json'), 'file');
      assert.deepStrictEqual(
        (await only()).map((copy) => copy.skipped),
        [CACHE_ONLY, CACHE_ONLY]
      );
    } finally {
      removeAccount(account.root);
    }
  });

  it('a lock row apl cannot use is one failed copy naming the row and the lock; the other rows keep their copies', async () => {
    const lockPath = join(project, 'apm.lock.yaml');
    const text = await readFile(lockPath, 'utf8');
    const before = (await findCopies(options())).copies;
    const lock = parseYaml(text) as { dependencies: Record<string, unknown>[] };
    // the spec's registry row has no folders, so it adds no copy; a row without any revision cannot be used
    lock.dependencies.push({ repo_url: 'https://github.com/acme-corp/security-baseline', source: 'registry', version: '2.1.0', resolved_hash: 'sha256:abc123...' }, { repo_url: 'o/unrevised', host: 'github.com' });
    await writeFile(lockPath, stringify(lock));
    try {
      const { copies } = await findCopies(options());
      assert.deepStrictEqual(copies.slice(0, before.length), before);
      assert.deepStrictEqual(copies.slice(before.length), [{ id: 'o/unrevised', folder: lockPath, place: await realpath(project), error: 'APM lock dependencies[3] has none of resolved_commit, resolved_hash and content_hash' }]);
    } finally {
      await writeFile(lockPath, text);
    }
  });

  it("an apl.json that links to a file outside the project is failed and never read: the native plugin's", async () => {
    const outside = join(root, 'outside-file');
    await mkdir(outside);
    await writeFile(join(outside, 'apl.json'), '{"scripts":{"install":"echo from-outside-file"}}');
    const native = join(project, '.agents', 'plugins', 'lifecycle-demo-dep');
    const options = { home: join(root, 'home'), apmHome: join(root, 'home', '.apm'), cwd: project, global: false };
    await writeFile(join(native, 'apl.json'), '{"scripts":{"install":"echo inside"}}');
    assert.strictEqual((await findCopies(options)).copies.find((copy) => copy.folder === native)?.install, 'echo inside');
    removeAccount(join(native, 'apl.json'));
    await symlink(join(outside, 'apl.json'), join(native, 'apl.json'), 'file');
    const copy = (await findCopies(options)).copies.find((item) => item.folder === native);
    assert.strictEqual(copy?.install, undefined);
    assert.strictEqual(copy?.error, `resolves to ${join(await realpath(outside), 'apl.json')}, outside ${project}`);
  });

  it('a folder the lock names that links outside the project is failed and never read', async () => {
    // the account's folder outside the home, and so outside the project
    const outside = join(root, 'outside');
    await writeFile(join(outside, 'apl.json'), '{"scripts":{"install":"node -e \\"\\""}}');
    const native = join(project, '.agents', 'plugins', 'lifecycle-demo');
    const before = await findCopies({ home: join(root, 'home'), apmHome: join(root, 'home', '.apm'), cwd: project, global: false });
    assert.ok(
      before.copies.some((copy) => copy.folder === native && copy.install),
      'the recorded native copy is a copy'
    );
    removeAccount(native);
    await symlink(outside, native, 'junction');
    const { copies } = await findCopies({ home: join(root, 'home'), apmHome: join(root, 'home', '.apm'), cwd: project, global: false });
    const linked = copies.find((copy) => copy.folder === native);
    assert.strictEqual(linked?.install, undefined);
    assert.match(linked?.error ?? '', /^resolves to .*outside, outside /);
  });
});

describe("findCopies never runs in APM's cache", () => {
  type Row = { repo_url: string; native_plugin?: { root: string } | null; deployed_files?: string[] };
  /** The recorded project-install step in a fresh account, with `change` applied to its lock rows first. */
  async function recordedProject(prefix: string, change: (rows: Row[]) => void = () => undefined) {
    const recording = await newestRecording();
    const step = recordedStep(recording, 'project-install');
    const account = await makeAccount(prefix);
    const lock = parseYaml(step.lock) as { dependencies: Row[] };
    change(lock.dependencies);
    const project = join(account.home, PROJECT);
    await placeStep(step, project, join(project, 'apm.lock.yaml'), account, stringify(lock));
    return { account, project, options: { home: account.home, apmHome: join(account.home, '.apm'), cwd: project, global: false } };
  }
  const shown = (copies: { folder: string; install?: string; error?: string; skipped?: string }[], root: string) =>
    copies.map(({ folder, install, error, skipped }) => [
      folder
        .slice(root.length + 1)
        .split('\\')
        .join('/'),
      install === undefined ? (skipped ?? error) : 'runs',
    ]);

  it('a recorded deployed folder or native plugin root inside apm_modules is skipped with that reason and never read', async () => {
    const { account, project, options } = await recordedProject('copies-in-cache', (rows) => {
      for (const row of rows) {
        const cached = `apm_modules/${row.repo_url}`;
        // the review's two shapes: a deployed skill folder in the cache, and a native plugin root in the cache
        if (row.repo_url === '_local/lifecycle-demo-dep') {
          row.native_plugin = null;
          row.deployed_files = [`${cached}/skills/shout`, `${cached}/skills/shout/SKILL.md`];
        } else if (row.native_plugin) row.native_plugin.root = cached;
      }
    });
    try {
      assert.deepStrictEqual(shown((await findCopies(options)).copies, project), [
        ['apm_modules/_local/lifecycle-demo', CACHE_ONLY],
        ['apm_modules/_local/lifecycle-demo/skills/greet', CACHE_ONLY],
        ['apm_modules/_local/lifecycle-demo-dep/skills/shout', CACHE_ONLY],
      ]);
    } finally {
      removeAccount(account.root);
    }
  });

  it('a recorded folder that is a link into apm_modules is skipped with that reason and never read', async () => {
    const { account, project, options } = await recordedProject('copies-link-cache');
    try {
      const native = join(project, '.agents', 'plugins', 'lifecycle-demo');
      removeAccount(native);
      await symlink(join(project, 'apm_modules', '_local', 'lifecycle-demo'), native, 'junction');
      // the other plugin's copies are untouched and still run
      assert.deepStrictEqual(shown((await findCopies(options)).copies, project), [
        ['.agents/plugins/lifecycle-demo', CACHE_ONLY],
        ['.agents/plugins/lifecycle-demo/skills/greet', CACHE_ONLY],
        ['.agents/plugins/lifecycle-demo-dep/skills/shout', 'runs'],
      ]);
    } finally {
      removeAccount(account.root);
    }
  });

  it('native plugins carry their cache root and skills: the recorded project reports nothing from the cache', async () => {
    const { account, project, options } = await recordedProject('copies-native-carries');
    try {
      assert.deepStrictEqual(shown((await findCopies(options)).copies, project), [
        ['.agents/plugins/lifecycle-demo', 'runs'],
        ['.agents/plugins/lifecycle-demo/skills/greet', 'runs'],
        ['.agents/plugins/lifecycle-demo-dep/skills/shout', 'runs'],
      ]);
    } finally {
      removeAccount(account.root);
    }
  });

  it('an apl.json at the root of a repository of plain skills reaches only the cache: it is reported skipped, and the deployed skill still runs', async () => {
    const recording = await newestRecording();
    const step = recordedStep(recording, 'gitskills-install');
    const account = await makeAccount('copies-skills-root');
    try {
      await placeStep(step, account.home, join(account.home, '.apm', 'apm.lock.yaml'), account);
      const skill = join(account.home, '.agents', 'skills', 'find-skills');
      const cacheRoot = join(account.home, '.apm', 'apm_modules', 'vercel-labs', 'skills');
      await writeFile(join(skill, 'apl.json'), GIT_MANIFEST);
      await writeFile(join(cacheRoot, 'apl.json'), GIT_MANIFEST);
      const { copies } = await findCopies({ home: account.home, apmHome: join(account.home, '.apm'), cwd: account.root, global: true });
      assert.deepStrictEqual(
        copies.map(({ id, folder, install, skipped }) => [id, folder, install === undefined ? skipped : 'runs']),
        [
          ['github.com/vercel-labs/skills:skills/find-skills', skill, 'runs'],
          ['github.com/vercel-labs/skills', cacheRoot, CACHE_ONLY],
        ]
      );
    } finally {
      removeAccount(account.root);
    }
  });
});
