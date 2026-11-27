import { chmod, mkdir, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'assert';
import { readStore, updateStore } from '../../../src/lib/store.ts';
import { removeAccount } from '../../lib/apm-live.ts';
import { scratch } from '../../lib/scratch.ts';

type Counts = { counts: Record<string, number> };
const parse = (value: Record<string, unknown>): Counts => {
  if (!value.counts || typeof value.counts !== 'object') throw new Error('counts must be an object');
  return value as Counts;
};
const empty = (): Counts => ({ counts: {} });

describe('store', () => {
  let root = '';
  before(async () => {
    root = await scratch('store');
  });
  after(() => removeAccount(root));

  it('concurrent updates each see the last write: the lock serialises them and no temporary file is left', async () => {
    const dir = join(root, 'apl');
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        updateStore(dir, 'counts.json', parse, empty, (value) => {
          value.counts[`k${index}`] = index;
        })
      )
    );
    assert.deepStrictEqual(Object.keys((await readStore(join(dir, 'counts.json'), parse, empty)).counts).sort(), ['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7']);
    assert.deepStrictEqual(await readdir(dir), ['counts.json']);
    if (process.platform !== 'win32') {
      assert.strictEqual((await stat(dir)).mode & 0o777, 0o700);
      assert.strictEqual((await stat(join(dir, 'counts.json'))).mode & 0o777, 0o600);
    }
  });

  it('a store folder or file writable by group or others is refused before it is read or written, naming the fix', async function () {
    // ownership and mode bits are not checked on Windows
    if (process.platform === 'win32') return this.skip();
    const dir = join(root, 'shared');
    await mkdir(dir);
    await writeFile(join(dir, 'counts.json'), '{"version":1,"counts":{}}');
    await chmod(dir, 0o777);
    await assert.rejects(() => readStore(join(dir, 'counts.json'), parse, empty), { message: `${dir} is writable by group or others: run chmod go-w ${dir}` });
    await assert.rejects(() => updateStore(dir, 'counts.json', parse, empty, () => undefined), { message: `${dir} is writable by group or others: run chmod go-w ${dir}` });
    await chmod(dir, 0o700);
    await chmod(join(dir, 'counts.json'), 0o666);
    await assert.rejects(() => readStore(join(dir, 'counts.json'), parse, empty), { message: `${join(dir, 'counts.json')} is writable by group or others: run chmod go-w ${join(dir, 'counts.json')}` });
    await chmod(join(dir, 'counts.json'), 0o600);
    assert.deepStrictEqual(await readStore(join(dir, 'counts.json'), parse, empty), { version: 1, counts: {} });
  });

  it('a store folder or file owned by another user is refused, also through a link, before it is read or written', async function () {
    // ownership is not checked on Windows; as root, the root-owned targets below would be the user's own
    if (process.platform === 'win32' || process.getuid?.() === 0) return this.skip();
    // stat follows links, so a link to a path root owns stands for a store that is not the user's: `/` and `/etc/hosts` exist on macOS and Linux
    const dir = join(root, 'owned');
    await mkdir(dir);
    await symlink('/etc/hosts', join(dir, 'counts.json'));
    await assert.rejects(() => readStore(join(dir, 'counts.json'), parse, empty), { message: `${join(dir, 'counts.json')} is not owned by you` });
    const linked = join(root, 'linked-dir');
    await symlink('/', linked);
    await assert.rejects(() => readStore(join(linked, 'counts.json'), parse, empty), { message: `${linked} is not owned by you` });
    await assert.rejects(() => updateStore(linked, 'counts.json', parse, empty, () => undefined), { message: `${linked} is not owned by you` });
  });

  it('a folder that cannot be created is an error naming it; unreadable content names the file', async () => {
    await writeFile(join(root, 'file'), '');
    const dir = join(root, 'file', 'apl');
    await assert.rejects(
      () => updateStore(dir, 'counts.json', parse, empty, () => undefined),
      (error: Error) => error.message.startsWith(`cannot write ${dir}: `)
    );
    await writeFile(join(root, 'bad.json'), '{"version":1,"counts":3}');
    await assert.rejects(() => readStore(join(root, 'bad.json'), parse, empty), /bad\.json: counts must be an object/);
    await writeFile(join(root, 'bom.json'), '\ufeff{"version":1,"counts":{"a":1}}');
    assert.deepStrictEqual(await readStore(join(root, 'bom.json'), parse, empty), { version: 1, counts: { a: 1 } }, 'a file saved by hand with a byte order mark reads');
    await writeFile(join(root, 'bad.json'), 'nope');
    await assert.rejects(() => readStore(join(root, 'bad.json'), parse, empty), /bad\.json is not valid JSON/);
  });
});
