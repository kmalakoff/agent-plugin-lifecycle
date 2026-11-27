import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'assert';
import { runScript } from '../../../src/lib/run.ts';
import { removeAccount } from '../../lib/apm-live.ts';
import { scratch } from '../../lib/scratch.ts';

describe('runScript', () => {
  let dir = '';
  before(async () => {
    dir = await scratch('run');
    await mkdir(join(dir, 'copy'));
  });
  after(() => removeAccount(dir));

  it('runs the command through the shell as written, in the folder, with the given environment', async () => {
    await runScript(`node -e "require('fs').writeFileSync('out', process.cwd() + '|' + process.env.APL_TEST)" && node -e "require('fs').appendFileSync('out', '|and')"`, join(dir, 'copy'), { ...process.env, APL_TEST: 'yes' });
    assert.strictEqual(await readFile(join(dir, 'copy', 'out'), 'utf8'), `${await realpath(join(dir, 'copy'))}|yes|and`);
  });

  it('standard input is closed, so a command that reads it gets end of input at once', async () => {
    await runScript(`node -e "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"`, join(dir, 'copy'), process.env);
  });

  it('a non-zero exit is the failure reason', async () => {
    await assert.rejects(() => runScript('node -e "process.exit(3)"', join(dir, 'copy'), process.env), /^Error: exit code 3$/);
  });

  it('a folder that does not exist fails to start', async () => {
    await assert.rejects(() => runScript('node -e ""', join(dir, 'gone'), process.env), /ENOENT/);
  });
});
