import assert from 'node:assert/strict';
import { parseConfig, runLifecycle } from 'agent-plugin-lifecycle';

describe('ESM package export', () => {
  it('loads the public parser and runner', () => {
    assert.equal(typeof parseConfig, 'function');
    assert.equal(typeof runLifecycle, 'function');
  });
});
