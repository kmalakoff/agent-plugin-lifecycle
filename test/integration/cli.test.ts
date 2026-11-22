import assert from 'node:assert/strict';
import { join } from 'node:path';
import spawn from 'cross-spawn-cb';

const bin = join(process.cwd(), 'bin', 'cli.js');

describe('installed CLI entry', () => {
  it('prints the available commands', () => {
    const result = spawn.sync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(String(result.stdout), /run/);
    assert.match(String(result.stdout), /check/);
  });

  it('skips project-scope APM events before reading user state', () => {
    const event = JSON.stringify({ schema_version: 1, event: 'post-install', scope: 'project', packages: [] });
    const result = spawn.sync(process.execPath, [bin, 'run'], { input: event, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(String(result.stdout), /skipped APM project scope event/);
  });

  it('rejects malformed lifecycle events', () => {
    assert.throws(
      () => spawn.sync(process.execPath, [bin, 'run'], { input: '{}', encoding: 'utf8' }),
      (error: { status?: number; stderr?: string }) => error.status === 2 && /unsupported APM lifecycle event/.test(String(error.stderr))
    );
  });
});
