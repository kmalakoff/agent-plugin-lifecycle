import assert from 'node:assert/strict';
import { parseConfig, recordId } from 'agent-plugin-lifecycle';

const valid = { version: 1, plugins: [{ source: 'git@bitbucket.org:team/plugins.git', path: 'plugins/demo', 'post-install': 'npm ci --prefix server', 'post-uninstall': 'node ~/.config/agent-plugin-lifecycle/cleanup.js' }] };
describe('parseConfig', () => {
  it('accepts independent source/path/skill records and direct event command strings', () => {
    const config = parseConfig({ ...valid, plugins: [...valid.plugins, { source: './plugin', skill: 'hello', 'post-install': 'npm ci' }] });
    assert.equal(config.plugins[0].source, 'git@bitbucket.org:team/plugins.git');
    assert.equal(config.plugins[0].path, 'plugins/demo');
    assert.equal(config.plugins[1].path, undefined);
    assert.equal(config.plugins[1].skill, 'hello');
    assert.equal(config.plugins[0]['post-install'], 'npm ci --prefix server');
    assert.notEqual(recordId(config.plugins[0]), recordId(config.plugins[1]));
  });
  it('rejects superseded fields and unsafe paths', () => {
    assert.throws(() => parseConfig({ ...valid, plugins: [{ ...valid.plugins[0], host: 'bitbucket.org' }] }), /unknown field/);
    assert.throws(() => parseConfig({ ...valid, plugins: [{ ...valid.plugins[0], path: '../escape' }] }), /safe relative/);
    assert.throws(() => parseConfig({ ...valid, plugins: [{ ...valid.plugins[0], skill: 'a/b' }] }), /one directory/);
    assert.throws(() => parseConfig({ ...valid, plugins: [{ ...valid.plugins[0], 'post-install': ['npm', 'ci'] }] }), /nonempty string/);
  });
  it('rejects duplicate source/path/skill identities but permits a plugin and skill record', () => {
    assert.throws(() => parseConfig({ ...valid, plugins: [valid.plugins[0], valid.plugins[0]] }), /duplicates/);
    assert.doesNotThrow(() => parseConfig({ version: 1, plugins: [{ source: './plugin' }, { source: './plugin', skill: 'demo' }] }));
  });
});
