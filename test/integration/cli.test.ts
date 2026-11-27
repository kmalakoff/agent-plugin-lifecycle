// The built CLI (bin/cli.js) against a disposable home under .tmp/, on the project and user locks of the newest recording that has
// both. Standard input is never a terminal here, so apl asks nothing: the question itself is covered through `approve` in the unit tests.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'assert';
import { parse as parseYaml, stringify } from 'yaml';
import { CACHE_ONLY, EXIT_ERROR, EXIT_NOT_OK, EXIT_OK, NO_PROJECT_LOCK, NOTHING_INSTALLED } from '../../src/constants.ts';
import { expectedCopies, GIT_MANIFEST, gitCopyFolders, isolatedEnvironment, listFiles, makeAccount, newestRecording, PLUGIN, PROJECT, packageRoot, placeFiles, placeStep, type RecordedStep, type Recording, recordedGitSource, recordedStep, relocate, removeAccount } from '../lib/apm-live.ts';
import { parseLines } from '../lib/output.ts';
import { type Result, runCommand } from '../lib/spawn.ts';

const bin = join(packageRoot, 'bin', 'cli.js');
const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;

const apl = (args: string[], cwd: string, env: NodeJS.ProcessEnv): Result => runCommand(process.execPath, [bin, ...args], cwd, env);
const statusesOf = (result: Result) => [...new Set(parseLines(result.stdout).map((line) => line.status))].sort();

describe('apl CLI', () => {
  let recording: Recording;
  let root = '';
  let home = '';
  let plugins = '';
  let project = '';
  let env: NodeJS.ProcessEnv = {};
  const place = async (scopeRoot: string, lockPath: string, step: RecordedStep) => {
    await placeFiles(scopeRoot, plugins, step.deployed);
    await mkdir(join(lockPath, '..'), { recursive: true });
    await writeFile(lockPath, relocate(step.lock, { home, plugins }, false));
  };

  before(async () => {
    recording = await newestRecording();
    ({ root, home, plugins } = await makeAccount('apl-cli'));
    project = join(home, PROJECT);
    env = isolatedEnvironment(home);
  });
  after(() => {
    if (root) removeAccount(root);
  });

  describe('arguments and scopes', () => {
    it('answers --version and --help before any work, and exits 2 on bad arguments', () => {
      assert.strictEqual(apl(['--version'], root, env).stdout.trim(), version);
      assert.strictEqual(apl(['-v'], root, env).stdout.trim(), version);
      assert.match(apl(['--help'], root, env).stdout, /install \[-g\] \[-y\] \[folder\.\.\.\]/);
      assert.match(apl(['install', '-h'], root, env).stdout, /--yes/);
      assert.match(apl(['status', '--help'], root, env).stdout, /--global/);
      for (const args of [[], ['nope'], ['install', '--strict'], ['install', '-g', 'some/folder'], ['status', '-y']]) {
        const result = apl(args, root, env);
        assert.strictEqual(result.status, EXIT_ERROR, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
      }
    });

    it('with no folder and no -g, the current folder must hold an apm.lock.yaml', () => {
      const result = apl(['status'], root, env);
      assert.strictEqual(result.status, EXIT_ERROR);
      assert.match(result.stderr, new RegExp(NO_PROJECT_LOCK));
    });

    it('-g with no user lock: nothing installed, exit 0', () => {
      for (const command of ['install', 'status']) {
        const result = apl([command, '-g'], root, env);
        assert.strictEqual(result.status, EXIT_OK);
        assert.strictEqual(result.stdout.trim(), NOTHING_INSTALLED);
      }
    });
  });

  describe('a project, run the way APM runs it (no terminal, in the project root)', () => {
    let copies: string[] = [];
    const lock = () => join(project, 'apm.lock.yaml');

    before(async () => {
      await place(project, lock(), recordedStep(recording, 'project-install'));
      copies = expectedCopies(project, await listFiles(project));
    });

    it('install without -y: every copy unapproved, nothing runs, nothing saved, exit 1', async () => {
      const result = apl(['install'], project, env);
      assert.strictEqual(result.status, EXIT_NOT_OK);
      assert.deepStrictEqual(
        parseLines(result.stdout)
          .map((line) => line.folder)
          .sort(),
        copies
      );
      assert.deepStrictEqual(statusesOf(result), ['unapproved']);
      await assert.rejects(() => stat(join(home, '.apl', 'approvals.json')), { code: 'ENOENT' });
      assert.deepStrictEqual(statusesOf(apl(['status'], project, env)), ['unapproved']);
    });

    it('install -y: approves and runs each copy, saved with private modes, exit 0; again: current', async () => {
      const result = apl(['install', '-y'], project, env);
      assert.strictEqual(result.status, EXIT_OK, `${result.stdout}${result.stderr}`);
      assert.deepStrictEqual(statusesOf(result), ['ran']);
      const approvals = JSON.parse(await readFile(join(home, '.apl', 'approvals.json'), 'utf8'));
      assert.strictEqual(approvals.version, 1);
      // saved under the project, the place it was given in
      assert.deepStrictEqual(Object.keys(approvals.approvals), [realpathSync(project)]);
      assert.ok(Object.keys(approvals.approvals[realpathSync(project)]).includes(`${join(plugins, PLUGIN)}:skills/greet`));
      if (process.platform !== 'win32') {
        assert.strictEqual((await stat(join(home, '.apl'))).mode & 0o777, 0o700);
        for (const file of ['approvals.json', 'state.json']) assert.strictEqual((await stat(join(home, '.apl', file))).mode & 0o777, 0o600);
      }
      const again = apl(['install'], project, env);
      assert.strictEqual(again.status, EXIT_OK);
      assert.deepStrictEqual(statusesOf(again), ['current']);
      assert.deepStrictEqual(statusesOf(apl(['status'], project, env)), ['ok']);
    });

    it('status: stale after APM installs a new revision; install runs it again without asking', async () => {
      await place(project, lock(), recordedStep(recording, 'project-reinstall'));
      const stale = apl(['status'], project, env);
      assert.strictEqual(stale.status, EXIT_NOT_OK);
      assert.deepStrictEqual(statusesOf(stale), ['ok', 'stale']);
      assert.deepStrictEqual(statusesOf(apl(['install'], project, env)), ['current', 'ran']);
      assert.strictEqual(apl(['status'], project, env).status, EXIT_OK);
    });

    it('status: unapproved when a command changes, missing when an approved script fails, failed for an invalid apl.json', async () => {
      const [first, second] = copies;
      await writeFile(join(first, 'apl.json'), JSON.stringify({ scripts: { install: 'node -e "process.exit(3)"' } }));
      const changed = parseLines(apl(['status'], project, env).stdout);
      assert.strictEqual(changed.find((line) => line.folder === first)?.status, 'unapproved');
      const failed = apl(['install', '-y'], project, env);
      assert.strictEqual(failed.status, EXIT_NOT_OK);
      assert.strictEqual(parseLines(failed.stdout).find((line) => line.folder === first)?.reason, 'exit code 3');
      assert.strictEqual(parseLines(apl(['status'], project, env).stdout).find((line) => line.folder === first)?.status, 'missing');
      await writeFile(join(second, 'apl.json'), '{ not json');
      const invalid = parseLines(apl(['status'], project, env).stdout).find((line) => line.folder === second);
      assert.strictEqual(invalid?.status, 'failed');
      assert.match(invalid?.reason ?? '', /apl\.json is not valid JSON/);
    });

    it('status after APM removes a plugin: left for each folder apl ran in that APM kept, which does not change the exit code', async () => {
      // the copies of the remaining package, repaired and run again, so that only `left` lines differ from ok
      await place(project, lock(), recordedStep(recording, 'project-reinstall'));
      assert.strictEqual(apl(['install', '-y'], project, env).status, EXIT_OK);
      await place(project, lock(), recordedStep(recording, 'project-uninstall'));
      const result = apl(['status'], project, env);
      assert.strictEqual(result.status, EXIT_OK, result.stdout);
      const left = parseLines(result.stdout).filter((line) => line.status === 'left');
      assert.ok(left.length > 0, result.stdout);
      for (const line of left) assert.ok(line.folder.startsWith(join(project, '.agents', 'plugins', PLUGIN)), line.text);
    });
  });

  describe('after the project', () => {
    it('started in the APM home (as APM starts a -g lifecycle command) it uses the user scope, where the project approvals do not apply', async () => {
      const apmHome = join(home, '.apm');
      await place(home, join(apmHome, 'apm.lock.yaml'), recordedStep(recording, 'install'));
      const result = apl(['install'], apmHome, env);
      const lines = parseLines(result.stdout);
      assert.ok(lines.length > 0, result.stdout);
      assert.ok(
        lines.every((line) => line.folder.startsWith(home) && !line.folder.startsWith(project)),
        result.stdout
      );
      // the same plugins were approved in the project; the user scope is another place
      assert.strictEqual(result.status, EXIT_NOT_OK);
      assert.deepStrictEqual(statusesOf(result), ['unapproved']);
      const approved = apl(['install', '-g', '-y'], root, env);
      assert.strictEqual(approved.status, EXIT_OK, approved.stdout);
      assert.deepStrictEqual(statusesOf(approved), ['ran']);
      assert.strictEqual(apl(['status'], apmHome, env).status, EXIT_OK);
    });

    it("named folders: each must hold an apl.json; a script's output goes to standard error, so standard output holds only apl's lines", async () => {
      const folder = join(root, 'talkative');
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'apl.json'), JSON.stringify({ scripts: { install: `node -e "console.log('ok forged /x'); console.error('to-stderr')"` } }));
      const result = apl(['install', '-y', folder], root, env);
      assert.strictEqual(result.status, EXIT_OK, `${result.stdout}${result.stderr}`);
      assert.strictEqual(result.stdout, `ran ${realpathSync(folder)} ${realpathSync(folder)}\n`);
      assert.match(result.stderr, /^ok forged \/x$/m);
      assert.match(result.stderr, /^to-stderr$/m);
    });

    it('named folders: an approved one runs every time', async () => {
      const folder = join(root, 'by-hand');
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'apl.json'), JSON.stringify({ scripts: { install: `node -e "require('fs').appendFileSync('runs','x')"` }, other: true }));
      const missing = apl(['install', join(root, 'nowhere')], root, env);
      assert.strictEqual(missing.status, EXIT_NOT_OK);
      assert.match(missing.stdout, /^failed .*: no apl\.json$/m);
      assert.strictEqual(apl(['install', '-y', 'by-hand'], root, env).status, EXIT_OK);
      assert.strictEqual(apl(['install', 'by-hand'], root, env).status, EXIT_OK);
      // a named folder is its own place, whatever folder apl is run in
      assert.strictEqual(apl(['install', folder], project, env).status, EXIT_OK);
      assert.strictEqual(await readFile(join(folder, 'runs'), 'utf8'), 'xxx');
      assert.deepStrictEqual(statusesOf(apl(['status', 'by-hand'], root, env)), ['ok']);
      const approvals = JSON.parse(await readFile(join(home, '.apl', 'approvals.json'), 'utf8')).approvals;
      assert.deepStrictEqual(Object.keys(approvals[realpathSync(folder)]), [realpathSync(folder)]);
    });
  });

  describe('approvals belong to the place they were given in', () => {
    // a project's own lock names a source approved in another place, with the same command: the approval does not carry over
    const ran = (folders: string[]) => folders.filter((folder) => ['installed.marker', 'setup.done', 'apl.marker'].some((file) => existsSync(join(folder, file))));

    it('a local source approved in one project is unapproved in a second project whose lock names the same path: exit 1, nothing runs', async () => {
      const second = join(home, 'second-project');
      await place(second, join(second, 'apm.lock.yaml'), recordedStep(recording, 'project-install'));
      const copies = expectedCopies(second, await listFiles(second));
      const approvals = JSON.parse(await readFile(join(home, '.apl', 'approvals.json'), 'utf8')).approvals;
      const approvedInFirst = Object.keys(approvals[realpathSync(project)]);
      const result = apl(['install'], second, env);
      assert.strictEqual(result.status, EXIT_NOT_OK, result.stdout);
      const lines = parseLines(result.stdout);
      assert.deepStrictEqual(lines.map((line) => line.folder).sort(), copies);
      assert.ok(
        lines.every((line) => approvedInFirst.includes(line.id ?? '')),
        'every id was approved in the first project'
      );
      assert.deepStrictEqual(statusesOf(result), ['unapproved']);
      assert.deepStrictEqual(ran(copies), []);
      const after = apl(['status'], second, env);
      assert.strictEqual(after.status, EXIT_NOT_OK);
      assert.deepStrictEqual(statusesOf(after), ['unapproved']);
    });

    it('a Git source approved at -g is unapproved in a project whose lock names the same id: exit 1, nothing runs', async () => {
      const step = recordedStep(recording, 'gitskills-install');
      const source = recordedGitSource(recording, 'gitskills');
      const other = await makeAccount('apl-cli-git-place');
      try {
        const otherEnv = isolatedEnvironment(other.home);
        const withManifests = async (scopeRoot: string) => {
          const folders = gitCopyFolders(scopeRoot, step.deployed);
          for (const folder of folders) {
            await mkdir(folder, { recursive: true });
            await writeFile(join(folder, 'apl.json'), GIT_MANIFEST);
          }
          return folders;
        };
        await placeStep(step, other.home, join(other.home, '.apm', 'apm.lock.yaml'), other);
        await withManifests(other.home);
        const user = apl(['install', '-g', '-y'], other.root, otherEnv);
        assert.strictEqual(user.status, EXIT_OK, `${user.stdout}${user.stderr}`);
        assert.deepStrictEqual(statusesOf(user), ['ran']);
        const approvedIds = parseLines(user.stdout).map((line) => line.id);

        const projectRoot = join(other.home, PROJECT);
        await placeStep(step, projectRoot, join(projectRoot, 'apm.lock.yaml'), other);
        const copies = await withManifests(projectRoot);
        const result = apl(['install'], projectRoot, otherEnv);
        assert.strictEqual(result.status, EXIT_NOT_OK, result.stdout);
        const lines = parseLines(result.stdout);
        assert.deepStrictEqual(lines.map((line) => line.folder).sort(), copies);
        assert.ok(lines.length > 0 && lines.every((line) => line.id?.startsWith(`${source.host}/${source.repo}`) && approvedIds.includes(line.id)), result.stdout);
        assert.deepStrictEqual(statusesOf(result), ['unapproved']);
        assert.deepStrictEqual(ran(copies), []);
        assert.deepStrictEqual(Object.keys(JSON.parse(await readFile(join(other.home, '.apl', 'approvals.json'), 'utf8')).approvals), [realpathSync(join(other.home, '.apm'))]);
      } finally {
        removeAccount(other.root);
      }
    });
  });

  describe('the environment and the files apl needs', () => {
    it('honours APM_HOME: -g uses the lock there, and so does running in that folder', async () => {
      const other = await makeAccount('apl-cli-apm-home');
      try {
        const apmHome = join(other.home, 'elsewhere', 'apm');
        const otherEnv = { ...isolatedEnvironment(other.home), APM_HOME: apmHome };
        await placeFiles(other.home, other.plugins, recordedStep(recording, 'install').deployed);
        await mkdir(apmHome, { recursive: true });
        await writeFile(join(apmHome, 'apm.lock.yaml'), relocate(recordedStep(recording, 'install').lock, { home: other.home, plugins: other.plugins }, false));
        const global = apl(['status', '-g'], other.root, otherEnv);
        assert.ok(parseLines(global.stdout).length > 0, `${global.stdout}${global.stderr}`);
        assert.deepStrictEqual(statusesOf(global), ['unapproved']);
        assert.deepStrictEqual(apl(['status'], apmHome, otherEnv).stdout, global.stdout);
        // the recorded step also left an (empty) ~/.apm/apm.lock.yaml; without it, the default APM home holds no lock
        removeAccount(join(other.home, '.apm', 'apm.lock.yaml'));
        assert.strictEqual(apl(['status', '-g'], other.root, isolatedEnvironment(other.home)).stdout.trim(), NOTHING_INSTALLED);
      } finally {
        removeAccount(other.root);
      }
    });

    it("a package whose only copy is APM's cache is skipped with the reason and does not change the exit code", async () => {
      const other = await makeAccount('apl-cli-skipped');
      try {
        const otherEnv = isolatedEnvironment(other.home);
        const step = recordedStep(recording, 'project-install');
        const lock = parseYaml(step.lock) as { dependencies: { repo_url: string; native_plugin?: unknown }[] };
        const demo = lock.dependencies.find((row) => row.repo_url === `_local/${PLUGIN}`);
        assert.ok(demo?.native_plugin, 'the recording deploys lifecycle-demo as a native plugin');
        delete demo.native_plugin;
        const projectRoot = join(other.home, PROJECT);
        await placeStep(step, projectRoot, join(projectRoot, 'apm.lock.yaml'), other, stringify(lock));
        const installed = apl(['install', '-y'], projectRoot, otherEnv);
        assert.strictEqual(installed.status, EXIT_OK, `${installed.stdout}${installed.stderr}`);
        const lines = parseLines(installed.stdout);
        assert.deepStrictEqual(statusesOf(installed), ['ran', 'skipped']);
        for (const line of lines.filter((item) => item.status === 'skipped')) {
          assert.strictEqual(line.reason, CACHE_ONLY);
          assert.ok(!existsSync(join(line.folder, 'installed.marker')) && !existsSync(join(line.folder, 'setup.done')), `nothing ran in ${line.folder}`);
        }
        const status = apl(['status'], projectRoot, otherEnv);
        assert.strictEqual(status.status, EXIT_OK, status.stdout);
        assert.deepStrictEqual(statusesOf(status), ['ok', 'skipped']);
      } finally {
        removeAccount(other.root);
      }
    });

    it('exits 2 for an unreadable lock and for an unwritable ~/.apl', async () => {
      const other = await makeAccount('apl-cli-exit-2');
      try {
        const otherEnv = isolatedEnvironment(other.home);
        const bad = join(other.root, 'bad-project');
        await mkdir(bad);
        await writeFile(join(bad, 'apm.lock.yaml'), 'dependencies: 3\n');
        const unreadable = apl(['status'], bad, otherEnv);
        assert.strictEqual(unreadable.status, EXIT_ERROR);
        assert.match(unreadable.stderr, /cannot read .*apm\.lock\.yaml/);
        // a cloned project names its own folder, and that name is in the message: a right-to-left override, legal in a folder name on
        // every OS, prints escaped inside one JSON string, never raw
        const hostile = join(other.root, 'proj\u202ex');
        await mkdir(hostile);
        await writeFile(join(hostile, 'apm.lock.yaml'), 'dependencies: 3\n');
        const escaped = apl(['status'], hostile, otherEnv);
        assert.strictEqual(escaped.status, EXIT_ERROR);
        assert.match(escaped.stderr, /^apl: "cannot read .*proj\\u202Ex.*apm\.lock\.yaml: APM lock dependencies must be an array"$/m);
        assert.ok(
          escaped.stderr.split('\n').every((text) => /^[ -~]*$/.test(text)),
          JSON.stringify(escaped.stderr)
        );
        const folder = join(other.root, 'skill');
        await mkdir(folder);
        await writeFile(join(folder, 'apl.json'), JSON.stringify({ scripts: { install: 'node -e ""' } }));
        // a file where the folder should be: no OS can create ~/.apl there
        await writeFile(join(other.home, '.apl'), '');
        const unwritable = apl(['install', '-y', folder], other.root, otherEnv);
        assert.strictEqual(unwritable.status, EXIT_ERROR);
        assert.match(unwritable.stderr, /cannot write .*\.apl/);
      } finally {
        removeAccount(other.root);
      }
    });
  });
});
