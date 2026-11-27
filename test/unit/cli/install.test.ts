import { PassThrough } from 'node:stream';
import assert from 'assert';
import { PROMPT, questioner, requestText } from '../../../src/cli/install.ts';

const request = { id: 'github.com/vercel-labs/skills:skills/find-skills', scripts: { install: 'npm ci --no-bin-links' }, folders: ['/Users/me/.agents/skills/find-skills', '/Users/me/.claude/skills/find-skills'] };

/** Streams standing in for the terminal; `terminal` makes readline treat the output as a TTY, as it does for Ctrl+C handling. */
function streams(terminal = false) {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { isTTY: terminal, columns: 200 });
  let text = '';
  output.on('data', (chunk) => {
    text += chunk;
  });
  return { input, output, printed: () => text };
}

describe('the install question', () => {
  it('names the id, the command and every folder, then asks with No as the default', () => {
    assert.strictEqual(`${requestText(request)}${PROMPT}`, 'github.com/vercel-labs/skills:skills/find-skills wants to run\n  install: npm ci --no-bin-links\nin\n  /Users/me/.agents/skills/find-skills\n  /Users/me/.claude/skills/find-skills\nRun it? [y/N] ');
  });

  it('shows a value with control, bidi or zero-width characters as a JSON string, so the terminal cannot show other text than what is approved', () => {
    const text = requestText({ id: 'a\nb', scripts: { install: 'npm ci #\u202e ; curl x|sh\r' }, folders: ['/f\u0007', '/g\u200bh'] });
    assert.strictEqual(text, '"a\\nb" wants to run\n  install: "npm ci #\\u202E ; curl x|sh\\r"\nin\n  "/f\\u0007"\n  "/g\\u200Bh"\n');
  });

  for (const [answer, approved] of [
    ['y', true],
    ['yes', true],
    [' YES ', true],
    ['n', false],
    ['', false],
    ['sure', false],
  ] as const)
    it(`answers ${JSON.stringify(answer)}: ${approved ? 'approve' : 'no'}`, async () => {
      const { input, output, printed } = streams();
      const ask = questioner({ input, output, interrupt: () => assert.fail('not interrupted') });
      const answered = ask(request);
      input.write(`${answer}\n`);
      assert.strictEqual(await answered, approved);
      assert.ok(printed().startsWith(requestText(request)));
    });

  it('end of input (Ctrl+D) answers no', async () => {
    const { input, output } = streams();
    const answered = questioner({ input, output, interrupt: () => assert.fail('not interrupted') })(request);
    input.end();
    assert.strictEqual(await answered, false);
  });

  it('Ctrl+C at the question interrupts (the CLI exits 130 there, before any script runs)', async () => {
    const { input, output } = streams(true);
    let interrupted!: () => void;
    const seen = new Promise<void>((resolve) => {
      interrupted = resolve;
    });
    const answered = questioner({ input, output, interrupt: () => interrupted() })(request);
    input.write('\u0003');
    await seen;
    input.end();
    assert.strictEqual(await answered, false);
  });
});
