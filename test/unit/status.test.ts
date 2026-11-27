import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'assert';
import { install } from '../../src/install.ts';
import { status } from '../../src/status.ts';
import { isolatedEnvironment, removeAccount } from '../lib/apm-live.ts';
import { scratch } from '../lib/scratch.ts';

describe('status (named folders)', () => {
  let dir = '';
  let home = '';
  let copy = '';
  const options = () => ({ home, cwd: dir, environment: isolatedEnvironment(home), folders: [copy] });
  before(async () => {
    dir = await realpath(await scratch('status'));
    home = join(dir, 'home');
    copy = join(dir, 'copy');
    await mkdir(copy);
    await writeFile(join(copy, 'apl.json'), JSON.stringify({ scripts: { install: 'node -e ""' } }));
  });
  after(() => removeAccount(dir));

  it('unapproved, then missing when approved but not yet succeeded, then ok; it changes nothing itself', async () => {
    assert.deepStrictEqual(await status(options()), [{ status: 'unapproved', id: copy, folder: copy }]);
    await writeFile(join(copy, 'apl.json'), JSON.stringify({ scripts: { install: 'node -e "process.exit(1)"' } }));
    await install({ ...options(), approve: async () => true });
    assert.deepStrictEqual(await status(options()), [{ status: 'missing', id: copy, folder: copy }]);
    await writeFile(join(copy, 'apl.json'), JSON.stringify({ scripts: { install: 'node -e ""' } }));
    assert.deepStrictEqual(await status(options()), [{ status: 'unapproved', id: copy, folder: copy }]);
    await install({ ...options(), approve: async () => true });
    assert.deepStrictEqual(await status(options()), [{ status: 'ok', id: copy, folder: copy }]);
  });
});
