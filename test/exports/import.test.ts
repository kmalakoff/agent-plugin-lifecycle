import { install, status } from 'agent-plugin-lifecycle';
import assert from 'assert';

describe('package export through the TypeScript loader', () => {
  it('loads install and status', () => {
    assert.strictEqual(typeof install, 'function');
    assert.strictEqual(typeof status, 'function');
  });
});
