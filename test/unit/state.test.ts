import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'assert';
import { safeRmSync } from 'fs-remove-compat';
import { computeStamp, isCurrent, parseState, readState, updateState } from '../../src/state.ts';
import { removeAccount } from '../lib/apm-live.ts';
import { scratch } from '../lib/scratch.ts';

describe('run records', () => {
  let home = '';
  before(async () => {
    home = await scratch('state');
  });
  after(() => removeAccount(home));

  it('a copy is current only for the same command and opaque stamp; legacy 0.3.0 records without stamp read cleanly and are stale', () => {
    const run = { id: 'id', install: 'npm ci', stamp: 'sha256:aaa', lock: '/l' };
    assert.strictEqual(isCurrent(run, 'npm ci', 'sha256:aaa'), true);
    assert.strictEqual(isCurrent(run, 'npm ci', 'sha256:bbb'), false);
    assert.strictEqual(isCurrent(run, 'npm install', 'sha256:aaa'), false);
    assert.strictEqual(isCurrent(undefined, 'npm ci', 'sha256:aaa'), false);
    const legacy = parseState({ runs: { '/f': { id: 'id', install: 'npm ci', revision: 'c:h', lock: '/l' } } });
    assert.strictEqual(isCurrent(legacy.runs['/f'], 'npm ci', 'sha256:aaa'), false);
  });

  it('computeStamp produces a sha256 digest that changes on content revision and on a recreated folder', async () => {
    const folder = join(home, 'stamped');
    await mkdir(folder);
    const base = await computeStamp(folder, 'rev-1');
    assert.match(base, /^sha256:[0-9a-f]{64}$/);
    assert.strictEqual(await computeStamp(folder, 'rev-1'), base);
    assert.notStrictEqual(await computeStamp(folder, 'rev-2'), base);
    // deleting and recreating the folder gives a new folder identity and thus a new stamp
    safeRmSync(folder);
    await mkdir(folder);
    assert.notStrictEqual(await computeStamp(folder, 'rev-1'), base);
  });

  it('records whose folder no longer exists are dropped the next time the file is written', async () => {
    const kept = join(home, 'kept');
    await mkdir(kept);
    await updateState(home, (state) => {
      state.runs[kept] = { id: 'a', install: 'x', stamp: 'sha256:111' };
      state.runs[join(home, 'gone')] = { id: 'b', install: 'y', stamp: 'sha256:222', lock: '/l' };
    });
    assert.deepStrictEqual(Object.keys((await readState(home)).runs), [kept]);
    assert.strictEqual(JSON.parse(await readFile(join(home, '.apl', 'state.json'), 'utf8')).version, 1);
  });

  it('rejects a record without id and install strings', () => {
    assert.throws(() => parseState({ runs: { '/f': { id: 'a' } } }), /run record for \/f/);
    assert.throws(() => parseState({ runs: [] }), /runs must be an object/);
  });
});
