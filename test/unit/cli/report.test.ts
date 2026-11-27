import assert from 'assert';
import { line } from '../../../src/cli/report.ts';
import type { CopyResult } from '../../../src/types.ts';
import { parseLines } from '../../lib/output.ts';

describe('result lines', () => {
  it('print the status, id and folder, with the reason after a failed or skipped one', () => {
    assert.strictEqual(line({ status: 'ran', id: 'github.com/o/r:skills/a', folder: '/p/.agents/skills/a' }), 'ran github.com/o/r:skills/a /p/.agents/skills/a');
    assert.strictEqual(line({ status: 'failed', id: '/p/x', folder: '/p/x', reason: 'exit code 3' }), 'failed /p/x /p/x: exit code 3');
    assert.strictEqual(line({ status: 'skipped', id: 'github.com/o/r', folder: '/p/apm_modules/o/r', reason: "APM's cache is the only copy; scripts do not run there" }), "skipped github.com/o/r /p/apm_modules/o/r: APM's cache is the only copy; scripts do not run there");
    assert.strictEqual(line({ status: 'left', folder: '/p/.agents/plugins/x' }), 'left /p/.agents/plugins/x');
  });

  it('escape the id, folder and reason as the question does, so each result stays one line of plain ASCII text', () => {
    // a lock host carrying a newline would otherwise print a second line that starts with `ok`
    assert.strictEqual(line({ status: 'unapproved', id: 'github.com\nok x /p', folder: '/p/\u202eskills' }), 'unapproved "github.com\\nok x /p" "/p/\\u202Eskills"');
    assert.strictEqual(line({ status: 'failed', id: 'i', folder: '/p/\u200bx', reason: 'bad\u001b[2K' }), 'failed i "/p/\\u200Bx": "bad\\u001B[2K"');
  });

  it('read back field by field as a script would: a Windows path as written, a field with a space as a JSON string', () => {
    const results: CopyResult[] = [
      { status: 'ran', id: 'D:\\a\\plugins\\demo:skills/greet', folder: 'D:\\a\\home\\.agents\\plugins\\demo\\skills\\greet' },
      { status: 'failed', id: '/Users/me/My Plugins/demo', folder: 'C:\\Users\\me\\x:', reason: 'resolves to C:\\Users\\other dir, outside C:\\Users\\me' },
      { status: 'skipped', id: 'github.com\nok x /p', folder: '/Users/me/My Project/apm_modules/o/r', reason: "APM's cache is the only copy; scripts do not run there" },
      { status: 'left', folder: '/Users/me/My Project/.agents/plugins/demo' },
    ];
    assert.deepStrictEqual(
      parseLines(results.map(line).join('\n')).map(({ status, id, folder, reason }) => ({ status, id, folder, reason })),
      results.map(({ status, id, folder, reason }) => ({ status, id, folder, reason }))
    );
  });
});
