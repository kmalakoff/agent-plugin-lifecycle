import assert from 'node:assert/strict';
import { matchesSource, parseLock, sourceParts } from 'agent-plugin-lifecycle';
import { parse as parseYaml } from 'yaml';
import { listRecordings, loadRecording } from '../lib/apm-live.ts';

const revision = { resolved_commit: 'a'.repeat(40), content_hash: `sha256:${'b'.repeat(64)}` };

describe('parseLock', () => {
  it('keeps plugins from one repository distinct by virtual path', () => {
    const dependencies = ['alpha', 'beta'].map((name) => ({
      name: 'srv/src',
      host: 'localhost',
      repo_url: 'srv/src',
      virtual_path: `plugins/${name}`,
      deployed_files: [],
      ...revision,
    }));
    const plugins = parseLock({ dependencies });
    assert.notEqual(plugins[0].path, plugins[1].path);
  });

  it('rejects unsafe deployed paths', () => {
    assert.throws(() => parseLock({ dependencies: [{ host: 'localhost', repo_url: 'srv/src', virtual_path: 'plugins/alpha', deployed_files: ['../escape'], ...revision }] }), /unsafe path segment/);
  });

  it('reads the local Agent Plugins v1 lock rows recorded from APM', async () => {
    const recording = await loadRecording(listRecordings()[0]);
    const plugins = parseLock(parseYaml(recording.steps.install.lock));
    assert.deepEqual(
      plugins.map((plugin) => ({ host: plugin.host, repo: plugin.repo, path: plugin.path, localPath: plugin.localPath })),
      [
        { host: 'local', repo: '_local/lifecycle-demo', path: '.', localPath: '<PLUGINS>/lifecycle-demo' },
        { host: 'local', repo: '_local/lifecycle-demo-dep', path: '.', localPath: '<PLUGINS>/lifecycle-demo-dep' },
      ]
    );
    for (const plugin of plugins) assert.match(plugin.revision, /^sha256:[0-9a-f]{64}$/);
  });

  it('matches supported Git URL forms and exact local paths', () => {
    const plugin = parseLock({ dependencies: [{ host: 'bitbucket.org', repo_url: 'team/plugins', virtual_path: '.', ...revision }] })[0];
    assert.deepEqual(sourceParts('git@bitbucket.org:team/plugins.git'), { host: 'bitbucket.org', repo: 'team/plugins' });
    assert.equal(matchesSource('https://bitbucket.org/team/plugins.git', plugin), true);
    assert.equal(matchesSource('https://other.example/team/plugins.git', plugin), false);
    const local = parseLock({ dependencies: [{ source: 'local', package_type: 'agent_plugin', repo_url: '_local/plugin', local_path: '/tmp/plugin', content_hash: `sha256:${'c'.repeat(64)}` }] })[0];
    assert.equal(matchesSource('/tmp/plugin', local), true);
  });

  it('compares local paths by their resolved form on each platform', () => {
    // the recorded lock relocated into a Windows home keeps the recorded "/" after the native plugins folder
    const lockPath = 'D:\\a\\work\\.tmp\\home\\plugins/lifecycle-demo';
    const configured = 'D:\\a\\work\\.tmp\\home\\plugins\\lifecycle-demo';
    assert.notEqual(lockPath, configured);
    const local = (path: string) => parseLock({ dependencies: [{ source: 'local', package_type: 'agent_plugin', repo_url: '_local/lifecycle-demo', local_path: path, content_hash: `sha256:${'c'.repeat(64)}` }] })[0];
    assert.equal(matchesSource(configured, local(lockPath), 'win32'), true);
    assert.equal(matchesSource(`${configured}\\`, local(lockPath), 'win32'), true);
    assert.equal(matchesSource('D:\\a\\other', local(lockPath), 'win32'), false);
    assert.equal(matchesSource('d:\\A\\WORK\\.tmp\\home\\Plugins\\Lifecycle-Demo', local(lockPath), 'win32'), true);
    assert.equal(matchesSource('/tmp/plugins/a/', local('/tmp/plugins//a'), 'linux'), true);
    assert.equal(matchesSource('/tmp/plugins/a', local('/tmp/plugins/b'), 'darwin'), false);
    assert.equal(matchesSource('/tmp/Plugins/a', local('/tmp/plugins/a'), 'linux'), false);
  });

  it('rejects a local Agent Plugin with an unsafe kept path', () => {
    assert.throws(() => parseLock({ dependencies: [{ source: 'local', package_type: 'agent_plugin', repo_url: '../outside', local_path: './plugin', content_hash: `sha256:${'a'.repeat(64)}` }] }), /unsafe path segment/);
  });
});
