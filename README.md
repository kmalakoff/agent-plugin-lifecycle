# agent-plugin-lifecycle

Lets an agent plugin or skill ship its own setup command, and runs it on your machine only after you approve it. The author puts an `apl.json` beside the plugin or skill:

```json
{ "scripts": { "install": "npm ci --no-bin-links" } }
```

An installer puts one copy of a plugin or skill in the folder of each agent harness (the agent tool that loads it, such as Claude Code, Copilot or Codex). The `apl` command finds each of those copies, asks you once per project (or once for your user install) whether to run the command, and runs it in each copy. After that, Agent Package Manager (APM) can call `apl install` after every install and update, so approved scripts run on their own and a changed plugin runs again once. Nothing runs that you have not approved, and you are asked again when the command changes ([Security model](#security-model)).

Installers copy plugins and skills into each harness but run none of their code: APM, the skills CLI, Claude Code and Codex all leave a plugin that needs `npm ci`, `uv sync` or any other setup without it. `apl` fills that gap.

Works with:

| Installer | How `apl` finds the copies | Runs on its own |
|---|---|---|
| [Agent Package Manager (APM)](https://github.com/microsoft/apm), `apm`; tested with APM 0.39.1 | APM's lock file, at project and user (`-g`) scope | yes, from APM's `post-install` entry |
| [The skills CLI](https://github.com/vercel-labs/skills), `npx skills add` | you name the folders | no: it has no install hook |
| Claude Code, Codex, or copying by hand | you name the folders | no |

Requires Node.js 22.18 or newer, on macOS, Linux or Windows.

```sh
npm install -g agent-plugin-lifecycle    # installs the `apl` command (also as `agent-plugin-lifecycle`)
apl --help
```

The npm package `apl` belongs to someone else: install `agent-plugin-lifecycle`, or run it once with `npx agent-plugin-lifecycle`. Coming from 0.2.0: follow the [upgrade steps](CHANGELOG.md#upgrading-from-02) once on each machine.

## For plugin and skill authors: add `apl.json`

Put `apl.json` in the folder that needs the setup:

- a skill: beside its `SKILL.md` (`skills/<name>/apl.json`). It arrives in every copy of the skill an installer deploys.
- a plugin: at the plugin root (beside `plugin.json`, or beside `.claude-plugin/` for a Claude Code plugin), not inside `.claude-plugin/`. It arrives in the plugin's native copy (`.agents/plugins/<name>/`).

| Field | Meaning |
|---|---|
| `scripts.install` | A nonempty command string. Runs after the plugin or skill is installed and after it is updated. |

Unknown fields and other script names are ignored. A file with no `scripts.install` has nothing to run.

Rules for the command:

- It runs through the platform shell (`sh`, or `cmd.exe` on Windows), exactly as written, with the folder that holds `apl.json` as its working directory. Write it for both shells if your users run both, or call a script: `node setup.js`.
- Standard input is closed. Its output, standard output included, goes to `apl`'s standard error.
- Make it safe to repeat, as `npm ci` and `uv sync` are. It runs again in each copy when the plugin changes or a copy is recreated.
- For npm in a plugin copy use `npm ci --no-bin-links`. APM refuses later installs of a copy that contains a symlink, and `node_modules/.bin` would add one.
- Do not put `apl.json` under `.apm/`, which APM strips from deployed copies. An `apl.json` at the root of a repository of plain skills reaches no skill copy, only APM's cache, so it is reported `skipped` and never runs; put it in each `skills/<name>/`.
- Changing the command makes every user approve it again.

Check it on your own copy: name the folder, approve with `-y`, then ask for its status. Your script's output comes first, then `apl`'s line:

```console
$ apl install -y skills/report
added 12 packages in 1s
ran /Users/me/team-skills/skills/report /Users/me/team-skills/skills/report
$ apl status skills/report
ok /Users/me/team-skills/skills/report /Users/me/team-skills/skills/report
```

A misspelt key, such as `postinstall`, gives `failed …: apl.json has no scripts.install` instead.

## For machine owners: approve and run

### With Agent Package Manager (APM)

Install a plugin or skill with APM as usual, in a project or with `-g` for your user:

```sh
apm install team/skills
```

Register `apl install` once in your user `~/.apm/apm.yml`. The entry fires for project installs and for `-g` installs alike, and APM fires `post-install` on every update too:

```yaml
name: my-machine          # APM requires name and version in this file
version: 0.0.0
lifecycle:
  post-install:
    - run: apl install
      timeoutSec: 300
```

- **`timeoutSec`**: APM kills a lifecycle command after 30 seconds unless the entry sets `timeoutSec`, and still exits 0. One `apl install` runs every script that is due, so allow time for all of them.
- **Secrets**: APM removes environment variables whose names look like credentials (`NPM_TOKEN`, `*_API_KEY`, `*_PASSWORD` and similar) from lifecycle commands. If a script needs one, list it on the entry: `allowedEnvVars: [NPM_TOKEN]`.
- APM writes the command's output to `~/.apm/logs/scripts.log`, not to your terminal.

Check the registration: `apm lifecycle` lists the entry (`post-install | command | apl install | user`).

The first time in each project, APM's run has no terminal, so `apl` approves nothing and APM prints:

```
[!] Lifecycle post-install command script exited with code 1; continuing. Output: /Users/me/.apm/logs/scripts.log
```

That is `apl` reporting a script waiting for your approval. Run `apl install` yourself, in the project (or with `-g` for a user install). It asks once per plugin or skill:

```console
$ apl install
github.com/team/skills:skills/report wants to run
  install: npm ci --no-bin-links
in
  /Users/me/project/.agents/skills/report
  /Users/me/project/.claude/skills/report
Run it? [y/N] y
added 12 packages in 1s
ran github.com/team/skills:skills/report /Users/me/project/.agents/skills/report
added 12 packages in 1s
ran github.com/team/skills:skills/report /Users/me/project/.claude/skills/report
```

From then on APM's entry runs it: approved scripts run in every new or changed copy, and APM's own run never asks, so a script you have not approved is only reported (the same line from APM again). Check the result after APM:

```sh
apm update && apl status
```

`apl install -y` approves every unapproved script without asking and saves those approvals, for CI or a machine you set up from a script. All questions come before any script runs, and the approvals are saved after the last one: Ctrl+C at any question stops `apl` (exit 130) with nothing saved and nothing run.

### With the skills CLI (`npx skills`)

The skills CLI has no install hook, so you run `apl` on the folders it creates. It writes the skill once under `.agents/skills/<name>` and links each other agent's folder to it (`.claude/skills/<name>` for Claude Code):

```console
$ npx skills add team/skills --skill report -a claude-code -a codex
$ apl install .agents/skills/report .claude/skills/report
/Users/me/project/.agents/skills/report wants to run
  install: npm ci --no-bin-links
in
  /Users/me/project/.agents/skills/report
Run it? [y/N] y
added 12 packages in 1s
ran /Users/me/project/.agents/skills/report /Users/me/project/.agents/skills/report
$ apl status .agents/skills/report .claude/skills/report
ok /Users/me/project/.agents/skills/report /Users/me/project/.agents/skills/report
```

The link resolves to the same folder, so it is one copy: one question, one line. With Claude Code alone (`-a claude-code`), the skills CLI copies the skill straight into `.claude/skills/<name>`; name that folder. With `-g`, the skills CLI writes under your home instead (`~/.agents/skills/report`, `~/.claude/skills/report`); name those folders. After `npx skills update`, run the same `apl install` again: a named folder's script runs every time you name it, because there is no installed revision to compare.

A named folder is its own id and place, so its path appears twice in each line. Each folder must hold an `apl.json` with a `scripts.install`. A folder named twice, also through a link, runs once.

### Any other installer, or by hand

For Claude Code, Codex, a skill you copied, or any other installer, name the folders the same way: `apl install <folder>...`, then `apl status <folder>...`.

## Security model

`apl` combines the install-script approval model of npm and other package managers with APM's rules for lifecycle trust:

- **Blocked by default.** No script runs until you approve it, the same default as npm's `allowScripts`, pnpm's `allowBuilds`, Bun's `trustedDependencies` and Deno's `allowScripts`.
- **You approve the exact command.** The question shows the command text, and a changed command is asked again.
- **An approval belongs to one place:** one project, your user install, or one named folder. As in npm, where `allowScripts` belongs to the project being installed, approving a skill in one project approves it nowhere else.
- **Approvals are stored per user in `~/.apl`, never in the project.** This is APM's rule for its own lifecycle trust: a file in the project could be committed by its author, so a cloned project could approve its own scripts. Also, `apl.json` ships inside each plugin or skill, so a project has no `apl` file of its own, where npm has `package.json`.
- **`~/.apl` must be yours.** On macOS and Linux, `apl` stops (exit 2) when `~/.apl` or a file in it is not owned by you or is writable by group or others, as OpenSSH does for `~/.ssh`. Fix it with `chmod go-w`.
- **Nothing is approved silently.** When APM runs `apl` there is no terminal, so `apl` asks nothing and runs only what is already approved. `-y` is the one explicit way to approve without a question.
- **`-y` approves everything unapproved at that moment, and saves it.** When an agent runs `apl install -y`, the agent approves for you: keep that command on ask in your agent's permissions, or run `apl install` yourself in a terminal.
- **Approval covers the command, not the version or the files it runs.** npm pins an approval to the version by default; `apl` does not pin the revision, because APM's run cannot ask: an update with the same command runs without a question. A new version can also change what `npm ci` installs without changing the command.
- **The id is a claim made by the lock.** It is the source APM's lock records; `apl` does not verify that a folder's content came from it. After you approve in a project, anyone who can change that project's lock file or its deployed folders can run code under that approval at the next install, as anyone who can change `package.json` can in npm: approve only in projects whose changes you trust.

## Which copies `apl` uses

With no folder, `apl` reads APM's lock file and looks for `apl.json` in each copy it names:

| Scope | Lock file | Copies |
|---|---|---|
| Project (default) | `./apm.lock.yaml` | under the current folder |
| User (`-g`, or `apl` run in the APM home, as APM runs it for `-g`) | `$APM_HOME/apm.lock.yaml`, default `~/.apm/apm.lock.yaml` | under your home folder |

With no folder and no `-g`, the current folder must hold an `apm.lock.yaml`; otherwise `apl` stops with `no apm.lock.yaml here: pass -g or a folder`.

The copies are the folders APM recorded in the lock:

- each skill folder APM deployed (`deployed_files`), wherever the harness keeps it, including a folder moved by `CLAUDE_CONFIG_DIR`;
- the native plugin folder (`native_plugin.root`, `.agents/plugins/<name>`), and each `skills/<name>/` inside it.

Scripts found through APM's lock never run in APM's cache (`apm_modules/`), because APM restores it on the next `apm update`, deleting the script's output:

- a lock entry or a link that points into the cache is not run;
- an `apl.json` in the cache that no recorded folder carries (the package root's, or a skill's) is reported `skipped` (`APM's cache is the only copy; scripts do not run there`);
- a folder you name yourself runs wherever it is.

Paths and links:

- In a project lock every recorded path must be relative; otherwise the lock is unreadable (exit 2).
- A folder the lock names is not read or run when its real path, after following links, is outside the project. At user scope a relative path must stay inside your home in the same way.
- At user scope an absolute path APM recorded, such as a `CLAUDE_CONFIG_DIR` outside your home, is used as it is, since that lock is your own file written by APM.
- A copy's `apl.json` that is a link to a file outside the project (or, for a relative path at user scope, outside your home) is refused the same way.
- A refused copy is reported `failed` (`resolves to …, outside …`); a refused folder only when its target holds an `apl.json`.

Two more cases fail without running anything:

- When copies of one id carry different commands, each is reported `failed` (`copies of <id> disagree on install`) and nothing is asked for them.
- A lock row `apl` cannot use for another reason (a field of the wrong type, no revision) is one `failed` line naming the row and the lock; the other rows carry on.

## Approvals

You approve an **id** in a **place**. The approval covers every copy with that id in that place, and nothing anywhere else:

| Copy found through | Id | Example |
|---|---|---|
| APM, Git source | `<host>/<repo>`, then `/<path>` for a plugin in a subfolder, then `:<folder>` when `apl.json` is below the package root | `github.com/vercel-labs/skills:skills/find-skills` |
| APM, local path | the absolute source path, then `:<folder>` | `/Users/me/plugins/demo:skills/hello` |
| Named folder | the folder's real absolute path | `/Users/me/project/.claude/skills/report` |

| Run | Place |
|---|---|
| A project | the real path of the project folder (the one holding `apm.lock.yaml`) |
| The user scope (`-g`) | the real path of the APM home, default `~/.apm` |
| A named folder | the folder's real path (the same as its id) |

So the same plugin is approved separately in each project and for your user install, and a project you clone cannot run a script by naming a source you approved somewhere else. A project you move or clone again is a new place and is asked again.

A script runs only when `~/.apl/approvals.json` holds, under the copy's place, the exact command text for its id:

```json
{
  "version": 1,
  "approvals": {
    "/Users/me/project": {
      "github.com/team/skills:skills/report": {
        "scripts": { "install": "npm ci --no-bin-links" },
        "approved": "2026-11-26T20:15:00.000Z"
      }
    }
  }
}
```

Answering anything but `y` saves nothing, and you are asked again next time. A script you never want stays `unapproved`: uninstall the plugin, or accept that `apl status` exits 1. To revoke an approval, delete its entry. Approvals belong to you and are never read from a project.

`~/.apl/state.json` records the last successful run in each copy (command, and the revision APM locked), so a copy that is already current is skipped. The record is removed while a script runs, so a failed or killed run leaves the copy `missing`. Both files are private to you (`0700` folder, `0600` files on macOS and Linux).

## Commands

```
apl install [-g] [-y] [folder...]   Run install scripts, asking before any that are not approved
apl status [-g] [folder...]         Report each copy; exit 1 unless every copy is ok
apl --help | -h
apl --version | -v
```

| Flag | Meaning |
|---|---|
| `-g`, `--global` | The user scope (`~/.apm`) instead of the project in the current folder, as with APM's `-g`. Not allowed with folders. |
| `-y`, `--yes` | `install` only: approve every unapproved script without asking, and save the approvals. |

`apl install` asks only when standard input and output are a terminal. It prints one line per copy, each as soon as its result is known (so it follows its script's output, and a run APM kills still shows what finished), or `nothing installed`. Standard output holds only these lines; scripts print to standard error.

| Line | Meaning |
|---|---|
| `ran <id> <folder>` | The script succeeded and the run was recorded. |
| `current <id> <folder>` | Already succeeded for this command and revision; skipped. |
| `unapproved <id> <folder>` | Not approved; not run. |
| `failed <id> <folder>: <reason>` | The script exited non-zero, `apl.json` is invalid, the folder links outside the scope, copies of the id disagree on the command, a lock row cannot be used, or a named folder has no `apl.json` or no `scripts.install`. |
| `skipped <id> <folder>: <reason>` | APM's cache is the only copy; scripts do not run there. |

`apl status` changes nothing:

| Line | Meaning |
|---|---|
| `ok <id> <folder>` | The current command succeeded here for the installed revision. |
| `missing <id> <folder>` | Approved, but it has not succeeded here. |
| `stale <id> <folder>` | It last succeeded for an older revision or an older command. |
| `unapproved <id> <folder>` | The command is not approved. |
| `failed <id> <folder>: <reason>` | `apl.json` is invalid, the folder links outside the scope, copies of the id disagree on the command, a lock row cannot be used, or a named folder has no `apl.json` or no `scripts.install`. |
| `skipped <id> <folder>: <reason>` | APM's cache is the only copy; scripts do not run there. |
| `left <folder>` | A folder a script ran in whose package APM has since removed. APM keeps a folder that holds files it did not write, such as `node_modules`; remove it yourself. |

Everything `apl` prints from a plugin, a lock or a folder name is escaped: the question (id, command, folders), every result line (id, folder, reason) and the error message of exit code 2. A value prints as it is when every character is printable ASCII, it has no leading or trailing space and it does not start with `"`; in a result line, an id or folder must also have no space. Any other value prints as a JSON string (the form a command has in `apl.json`), with every other character escaped in ASCII. So a Windows path or a command with quotes reads as written, a field that starts with `"` is always a JSON string, and the text you approve is the text that runs.

| Exit code | Meaning |
|---|---|
| 0 | Every copy is `ran`, `current`, `ok` or `skipped` (`left` lines do not count), or nothing is installed. |
| 1 | At least one copy is `unapproved`, `failed`, `missing` or `stale`. |
| 2 | `apl` could not do its work: bad arguments, an unreadable lock file, an unwritable `~/.apl`, or a `~/.apl` that others can write. |
| 130 | Ctrl+C at the approval question; nothing was saved or run. |

APM exits 0 even when a lifecycle command fails or times out, so a script that relies on the setup should run `apl status` after APM.

## Library

```ts
import { status } from 'agent-plugin-lifecycle';

const results = await status({ folders: ['.claude/skills/report'] });
for (const result of results) console.log(result.status, result.folder);
```

`install` and `status` each return one `{ status, id, folder, reason }` per line above and print nothing. `install({ approve })` takes an async function that receives `{ id, scripts: { install }, folders }` and resolves to `true` to approve; without it, unapproved copies are not run. `install({ onResult })` is called with each result as soon as it is known. The options `home`, `apmHome`, `cwd`, `environment`, `global` and `folders` are described in the generated types.

## Agent skill

```sh
npx skills add kmalakoff/agent-plugin-lifecycle   # -g for global, -a <agent> to target
```

The skill teaches an agent to add an `apl.json` to a plugin or skill, register `apl install` with APM, approve scripts and read `apl status`. It installs from Git, separately from the npm package.

## Help and license

Questions and bugs: [GitHub issues](https://github.com/kmalakoff/agent-plugin-lifecycle/issues). MIT license.
