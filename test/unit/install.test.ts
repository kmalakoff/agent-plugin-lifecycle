import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'assert';
import { safeRmSync } from 'fs-remove-compat';
import { parse as parseYaml, stringify } from 'yaml';
import { readApprovals } from '../../src/approvals.ts';
import { install } from '../../src/install.ts';
import { readState, updateState } from '../../src/state.ts';
import type { ApprovalRequest, CopyResult } from '../../src/types.ts';
import { isolatedEnvironment, makeAccount, newestRecording, placeStep, recordedStep, removeAccount } from '../lib/apm-live.ts';
import { scratch } from '../lib/scratch.ts';

const count = (file: string) => `node -e "require('fs').appendFileSync('${file}','x')"`;

describe('install (named folders)', () => {
  let dir = '';
  let home = '';
  let a = '';
  let b = '';
  const options = () => ({ home, cwd: dir, environment: isolatedEnvironment(home), folders: ['a', 'b'] });
  before(async () => {
    dir = await realpath(await scratch('install'));
    home = join(dir, 'home');
    a = join(dir, 'a');
    b = join(dir, 'b');
    for (const folder of [a, b]) await mkdir(folder, { recursive: true });
    await writeFile(join(a, 'apl.json'), JSON.stringify({ scripts: { install: count('runs') } }));
    await writeFile(join(b, 'apl.json'), JSON.stringify({ scripts: { install: 'node -e "process.exit(4)"' } }));
  });
  after(() => removeAccount(dir));

  it('without approve, unapproved copies are reported and nothing runs or is saved', async () => {
    assert.deepStrictEqual(
      (await install(options())).map(({ status }) => status),
      ['unapproved', 'unapproved']
    );
    assert.deepStrictEqual(await readApprovals(home), { approvals: {} });
  });

  it('approve is asked once per id with the command and its folders; no saves nothing, yes saves the approval and runs', async () => {
    const asked: ApprovalRequest[] = [];
    const results = await install({
      ...options(),
      approve: async (request) => {
        asked.push(request);
        return request.id === a;
      },
    });
    assert.deepStrictEqual(asked, [
      { id: a, scripts: { install: count('runs') }, folders: [a] },
      { id: b, scripts: { install: 'node -e "process.exit(4)"' }, folders: [b] },
    ]);
    assert.deepStrictEqual(results, [
      { status: 'ran', id: a, folder: a },
      { status: 'unapproved', id: b, folder: b },
    ]);
    // a named folder is its own place
    const { approvals } = await readApprovals(home);
    assert.deepStrictEqual(Object.keys(approvals), [a]);
    assert.deepStrictEqual(Object.keys(approvals[a]), [a]);
    assert.strictEqual(await readFile(join(a, 'runs'), 'utf8'), 'x');
  });

  it('an approved named folder runs every time; asked nothing once approved', async () => {
    const results = await install({ ...options(), approve: async () => assert.fail('nothing to ask for a'), folders: ['a'] });
    assert.deepStrictEqual(results, [{ status: 'ran', id: a, folder: a }]);
    assert.strictEqual(await readFile(join(a, 'runs'), 'utf8'), 'xx');
    const record = (await readState(home)).runs[a];
    assert.deepStrictEqual(Object.keys(record).sort(), ['id', 'install', 'stamp']);
    assert.strictEqual(record.id, a);
    assert.strictEqual(record.install, count('runs'));
    assert.match(record.stamp ?? '', /^sha256:[0-9a-f]{64}$/);
  });

  it('an approved named folder stays approved when named from another folder', async () => {
    const results = await install({ ...options(), cwd: join(dir, 'home'), approve: async () => assert.fail('nothing to ask for a'), folders: [join('..', 'a')] });
    assert.deepStrictEqual(results, [{ status: 'ran', id: a, folder: a }]);
    assert.strictEqual(await readFile(join(a, 'runs'), 'utf8'), 'xxx');
  });

  it('the text approved is the text that runs: apl.json rewritten while the question is open runs the approved command, and the next run is unapproved', async () => {
    const c = join(dir, 'c');
    await mkdir(c, { recursive: true });
    await writeFile(join(c, 'apl.json'), JSON.stringify({ scripts: { install: count('approved') } }));
    const results = await install({
      ...options(),
      folders: ['c'],
      approve: async () => {
        await writeFile(join(c, 'apl.json'), JSON.stringify({ scripts: { install: count('swapped') } }));
        return true;
      },
    });
    assert.deepStrictEqual(results, [{ status: 'ran', id: c, folder: c }]);
    assert.ok(existsSync(join(c, 'approved')) && !existsSync(join(c, 'swapped')));
    assert.deepStrictEqual(await install({ ...options(), folders: ['c'] }), [{ status: 'unapproved', id: c, folder: c }]);
  });

  it('each result is delivered as soon as it is known, before the next script starts', async () => {
    const [d, e] = [join(dir, 'd'), join(dir, 'e')];
    for (const folder of [d, e]) {
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'apl.json'), JSON.stringify({ scripts: { install: count('runs') } }));
    }
    const delivered: [CopyResult, boolean][] = [];
    const results = await install({ ...options(), folders: ['d', 'e'], approve: async () => true, onResult: (result) => delivered.push([result, existsSync(join(e, 'runs'))]) });
    assert.deepStrictEqual(delivered, [
      [{ status: 'ran', id: d, folder: d }, false],
      [{ status: 'ran', id: e, folder: e }, true],
    ]);
    assert.deepStrictEqual(
      results,
      delivered.map(([result]) => result)
    );
  });

  it('approvals are saved after the last answer: yes, then an interrupt at the next question, saves nothing and runs nothing', async () => {
    const [f, g] = [join(dir, 'f'), join(dir, 'g')];
    for (const folder of [f, g]) {
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'apl.json'), JSON.stringify({ scripts: { install: count('runs') } }));
    }
    const before = await readApprovals(home);
    let asked = 0;
    await assert.rejects(
      () =>
        install({
          ...options(),
          folders: ['f', 'g'],
          approve: async () => {
            if (asked++ === 0) return true;
            throw new Error('interrupted');
          },
        }),
      /interrupted/
    );
    assert.strictEqual(asked, 2);
    assert.deepStrictEqual(await readApprovals(home), before);
    assert.ok(!existsSync(join(f, 'runs')) && !existsSync(join(g, 'runs')));
  });

  it('a failing script is failed with its exit code and leaves no run record', async () => {
    const results = await install({ ...options(), approve: async () => true, folders: ['b'] });
    assert.deepStrictEqual(results, [{ status: 'failed', id: b, folder: b, reason: 'exit code 4' }]);
    assert.strictEqual((await readState(home)).runs[b], undefined);
  });

  it('a changed command is asked again; an invalid apl.json is failed and the other folders continue', async () => {
    await writeFile(join(a, 'apl.json'), JSON.stringify({ scripts: { install: count('again') } }));
    await writeFile(join(b, 'apl.json'), '{"scripts":{"install":""}}');
    const asked: string[] = [];
    const results = await install({
      ...options(),
      approve: async (request) => {
        asked.push(request.scripts.install);
        return true;
      },
    });
    assert.deepStrictEqual(asked, [count('again')]);
    assert.deepStrictEqual(results, [
      { status: 'ran', id: a, folder: a },
      { status: 'failed', id: b, folder: b, reason: 'apl.json scripts.install must be a nonempty string' },
    ]);
  });
});

describe('install (a recorded user lock with two copies of one skill)', () => {
  // APM deploys a skill to .agents/skills and .claude/skills when both targets are chosen (implementation report, item 1c);
  // the recorded user lock deployed `shout` for copilot only, so the .claude copy is added to its row
  let root = '';
  let home = '';
  let copies: string[] = [];
  const options = () => ({ home, global: true, cwd: root, environment: isolatedEnvironment(home) });
  before(async () => {
    const recording = await newestRecording();
    const account = await makeAccount('install-two-copies');
    ({ root, home } = account);
    const lock = parseYaml(recordedStep(recording, 'install').lock) as { dependencies: { repo_url: string; deployed_files?: string[] }[] };
    const dep = lock.dependencies.find((row) => row.repo_url === '_local/lifecycle-demo-dep');
    const deployed = dep?.deployed_files;
    if (!deployed?.includes('.agents/skills/shout/apl.json')) throw new Error('the recording no longer deploys shout to .agents/skills');
    deployed.push('.claude/skills/shout', '.claude/skills/shout/SKILL.md', '.claude/skills/shout/apl.json');
    const step = { ...recordedStep(recording, 'install'), deployed: [...recordedStep(recording, 'install').deployed, '.claude/skills/shout/SKILL.md', '.claude/skills/shout/apl.json'] };
    await placeStep(step, home, join(home, '.apm', 'apm.lock.yaml'), account, stringify(lock));
    copies = [join(home, '.agents', 'skills', 'shout'), join(home, '.claude', 'skills', 'shout')];
    await mkdir(copies[1], { recursive: true });
  });
  after(() => removeAccount(root));

  it('asks one question per id, listing every folder of that id', async () => {
    const asked: ApprovalRequest[] = [];
    await install({
      ...options(),
      approve: async (request) => {
        asked.push(request);
        return false;
      },
    });
    const shout = asked.filter((request) => request.id.endsWith(':skills/shout'));
    assert.strictEqual(shout.length, 1);
    assert.deepStrictEqual(shout[0].folders, copies);
    assert.strictEqual(new Set(asked.map((request) => request.id)).size, asked.length, 'one request per id');
  });

  it('copies of one id that carry different commands are failed and nothing is asked for them', async () => {
    await writeFile(join(copies[1], 'apl.json'), JSON.stringify({ scripts: { install: 'node -e "process.exit(0)"' } }));
    const asked: string[] = [];
    const results = await install({
      ...options(),
      approve: async (request) => {
        asked.push(request.id);
        return true;
      },
    });
    const shout = results.filter((result) => result.id?.endsWith(':skills/shout'));
    assert.deepStrictEqual(
      shout.map(({ status, folder, reason }) => ({ status, folder, reason })),
      copies.map((folder) => ({ status: 'failed', folder, reason: `copies of ${shout[0].id} disagree on install` }))
    );
    assert.ok(!asked.some((id) => id.endsWith(':skills/shout')));
  });
});

describe('install (per-copy revisions, recreated copies, and 0.3.0 state records)', () => {
  it('keeps sibling skills current when only one changes, re-runs a recreated copy, and re-runs a 0.3.0 record without stamp once', async () => {
    const account = await makeAccount('install-per-copy');
    try {
      const { root, home } = account;
      const env = isolatedEnvironment(home);
      const alpha = join(home, '.agents', 'skills', 'alpha');
      const beta = join(home, '.agents', 'skills', 'beta');
      await mkdir(alpha, { recursive: true });
      await mkdir(beta, { recursive: true });
      await writeFile(join(alpha, 'apl.json'), JSON.stringify({ scripts: { install: count('runs') } }));
      await writeFile(join(beta, 'apl.json'), JSON.stringify({ scripts: { install: count('runs') } }));
      const writeLock = async (commit: string, alphaHash: string) => {
        await mkdir(join(home, '.apm'), { recursive: true });
        await writeFile(
          join(home, '.apm', 'apm.lock.yaml'),
          stringify({
            lockfile_version: '4',
            dependencies: [
              {
                repo_url: 'team/skills',
                host: 'github.com',
                resolved_commit: commit,
                deployed_files: ['.agents/skills/alpha', '.agents/skills/alpha/SKILL.md', '.agents/skills/alpha/apl.json', '.agents/skills/beta', '.agents/skills/beta/SKILL.md', '.agents/skills/beta/apl.json'],
                deployed_file_hashes: {
                  '.agents/skills/alpha/SKILL.md': alphaHash,
                  '.agents/skills/alpha/apl.json': 'sha256:aaa',
                  '.agents/skills/beta/SKILL.md': 'sha256:bbb',
                  '.agents/skills/beta/apl.json': 'sha256:ccc',
                },
                skill_subset: ['alpha', 'beta'],
              },
            ],
          })
        );
      };
      const sha1 = '1111111111111111111111111111111111111111';
      const sha2 = '2222222222222222222222222222222222222222';
      await writeLock(sha1, 'sha256:v1');

      const first = await install({ home, cwd: root, global: true, environment: env, approve: async () => true });
      assert.deepStrictEqual(
        first.map(({ status }) => status),
        ['ran', 'ran']
      );

      // new repository commit where only alpha's hash changed: alpha runs, beta stays current
      await writeLock(sha2, 'sha256:v2');
      const partial = await install({ home, cwd: root, global: true, environment: env });
      assert.deepStrictEqual(
        partial.map(({ status, folder }) => [status, folder]),
        [
          ['ran', alpha],
          ['current', beta],
        ]
      );
      assert.strictEqual(await readFile(join(alpha, 'runs'), 'utf8'), 'xx');
      assert.strictEqual(await readFile(join(beta, 'runs'), 'utf8'), 'x');

      // deleting and recreating beta at the same revision re-runs beta because its folder identity changed
      safeRmSync(beta);
      await mkdir(beta, { recursive: true });
      await writeFile(join(beta, 'apl.json'), JSON.stringify({ scripts: { install: count('runs') } }));
      const recreated = await install({ home, cwd: root, global: true, environment: env });
      assert.deepStrictEqual(
        recreated.map(({ status, folder }) => [status, folder]),
        [
          ['current', alpha],
          ['ran', beta],
        ]
      );
      assert.strictEqual(await readFile(join(beta, 'runs'), 'utf8'), 'x');

      // a legacy 0.3.0 state record (revision, no stamp) runs once more and writes a stamp
      await updateState(home, (state) => {
        state.runs[alpha] = { id: 'github.com/team/skills:skills/alpha', install: count('runs'), revision: sha2, lock: join(home, '.apm', 'apm.lock.yaml') };
      });
      const upgraded = await install({ home, cwd: root, global: true, environment: env });
      assert.deepStrictEqual(
        upgraded.map(({ status, folder }) => [status, folder]),
        [
          ['ran', alpha],
          ['current', beta],
        ]
      );
      assert.match((await readState(home)).runs[alpha].stamp ?? '', /^sha256:[0-9a-f]{64}$/);
    } finally {
      removeAccount(account.root);
    }
  });
});
