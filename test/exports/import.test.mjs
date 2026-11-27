import { install, status } from 'agent-plugin-lifecycle';
import assert from 'assert';

describe('ESM package export', () => {
  it('loads install and status', () => {
    assert.strictEqual(typeof install, 'function');
    assert.strictEqual(typeof status, 'function');
  });
});
