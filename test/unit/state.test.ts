import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'assert';
import { isCurrent, parseState, readState, updateState } from '../../src/state.ts';
import { removeAccount } from '../lib/apm-live.ts';
import { scratch } from '../lib/scratch.ts';

describe('run records', () => {
  let home = '';
  before(async () => {
    home = await scratch('state');
  });
  after(() => removeAccount(home));

  it('a copy is current only for the same command and the same revision; a named folder has no revision on either side', () => {
    const run = { id: 'id', install: 'npm ci', revision: 'c:h', lock: '/l' };
    assert.strictEqual(isCurrent(run, 'npm ci', 'c:h'), true);
    assert.strictEqual(isCurrent(run, 'npm ci', 'c:other'), false);
    assert.strictEqual(isCurrent(run, 'npm install', 'c:h'), false);
    assert.strictEqual(isCurrent(undefined, 'npm ci', 'c:h'), false);
    assert.strictEqual(isCurrent({ id: 'id', install: 'npm ci' }, 'npm ci', undefined), true);
  });

  it('records whose folder no longer exists are dropped the next time the file is written', async () => {
    const kept = join(home, 'kept');
    await mkdir(kept);
    await updateState(home, (state) => {
      state.runs[kept] = { id: 'a', install: 'x' };
      state.runs[join(home, 'gone')] = { id: 'b', install: 'y', revision: 'r', lock: '/l' };
    });
    assert.deepStrictEqual(Object.keys((await readState(home)).runs), [kept]);
    assert.strictEqual(JSON.parse(await readFile(join(home, '.apl', 'state.json'), 'utf8')).version, 1);
  });

  it('rejects a record without id and install strings', () => {
    assert.throws(() => parseState({ runs: { '/f': { id: 'a' } } }), /run record for \/f/);
    assert.throws(() => parseState({ runs: [] }), /runs must be an object/);
  });
});
