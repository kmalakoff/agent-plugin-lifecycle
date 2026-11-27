// Live skills CLI suite: runs the real `npx skills add` (a pinned CLI release, a pinned public repository) and the built `apl` CLI on
// the folders it creates, as the README's "With the skills CLI" section does. It needs the network (the npm registry and GitHub).
// Everything both write stays inside a disposable home under .tmp/.
//
//   TEST_SKILLS_STRICT=true   no network fails the suite instead of skipping it (the APM workflow sets this)
// Without it the suite skips only when the network is absent; a reachable registry or GitHub that refuses (a 429, a 5xx) fails.

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'assert';
import { EXIT_NOT_OK, EXIT_OK } from '../../src/constants.ts';
import { GIT_MANIFEST, GIT_SKILLS_SOURCE, isolatedEnvironment, makeAccount, PROJECT, packageRoot, removeAccount } from '../lib/apm-live.ts';
import { parseLines } from '../lib/output.ts';
import { runCommand } from '../lib/spawn.ts';

const strict = process.env.TEST_SKILLS_STRICT === 'true';
const cli = join(packageRoot, 'bin', 'cli.js');
/** The skills CLI release the suite runs, and the source it installs: the commit the APM suite pins for the same repository. */
const SKILLS_CLI = 'skills@1.9.1';
const SOURCE = `${GIT_SKILLS_SOURCE.repo}#v1.2.0`;
const SKILL = GIT_SKILLS_SOURCE.skill ?? '';
/** The skills CLI writes the skill once under `.agents/skills` (Codex reads it there) and links the Claude Code folder to it. */
const AGENTS = ['claude-code', 'codex'];
/** What npm and git print when a name cannot be resolved or there is no route: the network is absent, not refusing. */
const NO_NETWORK = /\b(?:EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH)\b|Could not resolve host/;

describe('live skills CLI: named folders', () => {
  let root = '';
  let home = '';
  let env: NodeJS.ProcessEnv = {};
  const skills = (args: string[], cwd: string) => runCommand('npx', ['-y', SKILLS_CLI, ...args], cwd, env);
  const apl = (args: string[], cwd: string) => runCommand(process.execPath, [cli, ...args], cwd, env);

  before(async function () {
    ({ root, home } = await makeAccount('skills-cli'));
    env = isolatedEnvironment(home, { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', NO_COLOR: '1' });
    // the capability is the network: npx fetches the CLI from the npm registry, and listing the source clones it from GitHub
    const probe = skills(['add', SOURCE, '--list'], root);
    if (probe.status !== 0) {
      const output = `${probe.stdout}${probe.stderr}`;
      const problem = `npx ${SKILLS_CLI} add ${SOURCE} --list failed (exit ${probe.status}): ${output}`;
      if (strict) throw new Error(`${problem} (TEST_SKILLS_STRICT=true needs the network)`);
      if (!NO_NETWORK.test(output)) throw new Error(`${problem} (the network is up, so this is a result, not an absence)`);
      console.log(`      skipping the skills CLI suite, no network: ${problem}`);
      this.skip();
    }
  });
  after(() => {
    if (root) removeAccount(root);
  });

  for (const scope of ['project', 'user (-g)'] as const) {
    it(`${scope}: \`npx skills add\` writes one copy and links the Claude Code folder to it; apl reports it unapproved without -y, runs it once with -y, and status is ok`, async () => {
      const user = scope !== 'project';
      const cwd = user ? root : join(home, PROJECT);
      await mkdir(cwd, { recursive: true });
      const added = skills(['add', SOURCE, '--skill', SKILL, ...AGENTS.flatMap((agent) => ['-a', agent]), ...(user ? ['-g'] : []), '-y'], cwd);
      assert.strictEqual(added.status, 0, `${added.stdout}${added.stderr}`);
      const base = user ? home : cwd;
      const folders = [join(base, '.agents', 'skills', SKILL), join(base, '.claude', 'skills', SKILL)];
      for (const folder of folders) assert.ok(existsSync(join(folder, 'SKILL.md')), `the skills CLI installed ${folder}:\n${added.stdout}`);
      // the layout the README documents: one real copy under .agents/skills, the Claude Code folder a link to it (a junction on Windows)
      assert.ok(lstatSync(folders[1]).isSymbolicLink(), `${folders[1]} is a link; if the skills CLI now copies, correct the README's skills CLI section`);
      assert.strictEqual(realpathSync(folders[1]), realpathSync(folders[0]));
      // the repository ships no apl.json: the test adds one to each installed copy, which a linked folder shares
      for (const folder of folders) await writeFile(join(folder, 'apl.json'), GIT_MANIFEST);
      const copies = [realpathSync(folders[0])];

      const unapproved = apl(['install', ...folders], cwd);
      assert.strictEqual(unapproved.status, EXIT_NOT_OK, `${unapproved.stdout}${unapproved.stderr}`);
      assert.deepStrictEqual(
        parseLines(unapproved.stdout).map((line) => [line.status, line.folder]),
        copies.map((copy) => ['unapproved', copy])
      );
      for (const copy of copies) assert.ok(!existsSync(join(copy, 'apl.marker')), 'nothing ran unapproved');

      const ran = apl(['install', '-y', ...folders], cwd);
      assert.strictEqual(ran.status, EXIT_OK, `${ran.stdout}${ran.stderr}`);
      assert.deepStrictEqual(
        parseLines(ran.stdout).map((line) => [line.status, line.folder]),
        copies.map((copy) => ['ran', copy])
      );
      for (const copy of copies) assert.strictEqual(await readFile(join(copy, 'apl.marker'), 'utf8'), 'yes');

      const status = apl(['status', ...folders], cwd);
      assert.strictEqual(status.status, EXIT_OK, `${status.stdout}${status.stderr}`);
      assert.deepStrictEqual(
        parseLines(status.stdout).map((line) => [line.status, line.folder]),
        copies.map((copy) => ['ok', copy])
      );
    });
  }
});
