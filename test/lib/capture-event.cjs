// Test helper run by APM as a lifecycle script: saves the event JSON APM writes to stdin
// as <dir>/<NNN>-<event>.json so the live suite can assert on and record the real payload.
const { mkdirSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const dir = process.argv[2];
let payload = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  payload += chunk;
});
process.stdin.on('end', () => {
  mkdirSync(dir, { recursive: true });
  let name = 'unknown';
  try {
    name = String(JSON.parse(payload).event);
  } catch {
    /* keep the raw payload so a schema change is visible in the suite */
  }
  const index = String(readdirSync(dir).length + 1).padStart(3, '0');
  writeFileSync(join(dir, `${index}-${name}.json`), payload);
});
