const assert = require('node:assert/strict');
const { parseConfig, runLifecycle } = require('agent-plugin-lifecycle');

describe('CommonJS package export', () => {
  it('loads the public parser and runner', () => {
    assert.equal(typeof parseConfig, 'function');
    assert.equal(typeof runLifecycle, 'function');
  });
});
