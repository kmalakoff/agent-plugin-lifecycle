import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'assert';
import { parseManifest, readManifest } from '../../src/manifest.ts';
import { removeAccount } from '../lib/apm-live.ts';
import { scratch } from '../lib/scratch.ts';

describe('parseManifest', () => {
  it('returns the install command, ignoring unknown fields and script names', () => {
    assert.strictEqual(parseManifest({ scripts: { install: 'npm ci', test: 'x' }, version: 3, extra: {} }), 'npm ci');
  });

  it('has nothing to run without scripts or scripts.install', () => {
    assert.strictEqual(parseManifest({}), undefined);
    assert.strictEqual(parseManifest({ scripts: {} }), undefined);
    assert.strictEqual(parseManifest({ scripts: { build: 'x' } }), undefined);
  });

  it('rejects a file that is not an object, a scripts that is not an object, and an install that is not a nonempty string', () => {
    for (const value of [null, [], 'npm ci', 3]) assert.throws(() => parseManifest(value), /apl\.json must be an object/);
    for (const scripts of [null, [], 'npm ci']) assert.throws(() => parseManifest({ scripts }), /scripts must be an object/);
    for (const install of ['', '   ', 3, null, ['npm ci']]) assert.throws(() => parseManifest({ scripts: { install } }), /scripts\.install must be a nonempty string/);
  });
});

describe('readManifest', () => {
  let dir = '';
  before(async () => {
    dir = await scratch('manifest');
  });
  after(() => removeAccount(dir));

  it('reads apl.json in the folder, with or without a byte order mark; a missing file rejects with ENOENT; invalid JSON names the file', async () => {
    const folder = join(dir, 'copy');
    await mkdir(folder);
    await assert.rejects(() => readManifest(folder), { code: 'ENOENT' });
    await writeFile(join(folder, 'apl.json'), '{ "scripts": { "install": "node setup.js" } }');
    assert.strictEqual(await readManifest(folder), 'node setup.js');
    await writeFile(join(folder, 'apl.json'), '\ufeff{ "scripts": { "install": "node setup.js" } }\r\n');
    assert.strictEqual(await readManifest(folder), 'node setup.js', 'a leading UTF-8 byte order mark and CRLF are accepted');
    await writeFile(join(folder, 'apl.json'), '{ "scripts": ');
    await assert.rejects(() => readManifest(folder), /^Error: apl\.json is not valid JSON/);
  });
});
