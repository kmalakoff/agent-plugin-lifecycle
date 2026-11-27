import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'assert';
import { isApproved, parseApprovals, readApprovals, saveApprovals } from '../../src/approvals.ts';
import { removeAccount } from '../lib/apm-live.ts';
import { scratch } from '../lib/scratch.ts';

describe('approvals', () => {
  let home = '';
  before(async () => {
    home = await scratch('approvals');
  });
  after(() => removeAccount(home));

  it('an id is approved only in the place it was approved in, and only for the exact command text saved for it', () => {
    const approvals = { approvals: { '/work/a': { 'github.com/o/r:skills/a': { scripts: { install: 'npm ci' }, approved: '2026-11-26T00:00:00.000Z' } } } };
    assert.strictEqual(isApproved(approvals, '/work/a', 'github.com/o/r:skills/a', 'npm ci'), true);
    assert.strictEqual(isApproved(approvals, '/work/a', 'github.com/o/r:skills/a', 'npm ci '), false);
    assert.strictEqual(isApproved(approvals, '/work/a', 'github.com/o/r:skills/b', 'npm ci'), false);
    assert.strictEqual(isApproved(approvals, '/work/b', 'github.com/o/r:skills/a', 'npm ci'), false);
    // names inherited from Object.prototype are neither places nor ids
    assert.strictEqual(isApproved(approvals, 'constructor', 'github.com/o/r:skills/a', 'npm ci'), false);
    assert.strictEqual(isApproved(approvals, '/work/a', 'constructor', 'npm ci'), false);
  });

  it('no file reads as no approvals; saving writes version 1 and replaces only the entry for that place and id', async () => {
    assert.deepStrictEqual(await readApprovals(home), { approvals: {} });
    await saveApprovals(
      home,
      [
        { place: '/work/a', id: 'id', install: 'npm ci' },
        { place: '/work/a', id: 'other', install: 'make' },
      ],
      new Date('2026-11-26T20:16:00.000Z')
    );
    // a later write keeps the other entries; one save may hold several places
    await saveApprovals(
      home,
      [
        { place: '/work/b', id: 'id', install: 'npm ci' },
        { place: '/work/a', id: 'id', install: 'npm ci --no-bin-links' },
      ],
      new Date('2026-11-26T20:18:00.000Z')
    );
    assert.deepStrictEqual(JSON.parse(await readFile(join(home, '.apl', 'approvals.json'), 'utf8')), {
      version: 1,
      approvals: {
        '/work/a': {
          id: { scripts: { install: 'npm ci --no-bin-links' }, approved: '2026-11-26T20:18:00.000Z' },
          other: { scripts: { install: 'make' }, approved: '2026-11-26T20:16:00.000Z' },
        },
        '/work/b': { id: { scripts: { install: 'npm ci' }, approved: '2026-11-26T20:18:00.000Z' } },
      },
    });
  });

  it('a file of another version or shape is an error naming it', async () => {
    assert.throws(() => parseApprovals({ approvals: { '/work/a': { id: { scripts: {} } } } }), /approval for id in \/work\/a must have/);
    // the shape before approvals belonged to a place is not read
    assert.throws(() => parseApprovals({ approvals: { id: { scripts: { install: 'npm ci' }, approved: '2026-11-26T00:00:00.000Z' } } }), /approval for scripts in id must have/);
    assert.throws(() => parseApprovals({ approvals: { '/work/a': [] } }), /approvals for \/work\/a must be an object/);
    const other = await scratch('approvals-other');
    try {
      await mkdir(join(other, '.apl'));
      await writeFile(join(other, '.apl', 'approvals.json'), '{"version":2,"approvals":{}}');
      await assert.rejects(() => readApprovals(other), /approvals\.json has unsupported version 2/);
    } finally {
      removeAccount(other);
    }
  });
});
