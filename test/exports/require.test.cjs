const assert = require('assert');
const { install, status } = require('agent-plugin-lifecycle');

describe('CommonJS package export', () => {
  it('loads install and status', () => {
    assert.strictEqual(typeof install, 'function');
    assert.strictEqual(typeof status, 'function');
  });
});
