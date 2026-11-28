---
name: agent-plugin-lifecycle
description: "Ship and run the setup command an agent plugin or skill needs (npm ci, uv sync, any language) with apl: write its apl.json, register `apl install` in APM's ~/.apm/apm.yml, approve scripts, and check copies with `apl status`. Use when a plugin or skill installed by APM, npx skills or by hand needs dependencies or setup, when writing or reviewing an apl.json, or when `apl` reports unapproved, missing, stale, failed or left."
---

# agent-plugin-lifecycle (`apl`)

Installers (Agent Package Manager (APM), the skills CLI `npx skills add`, Claude Code, Codex) copy a plugin or skill into each harness and run none of its code. The author ships the setup command in `apl.json`; the machine owner approves it once; `apl install` runs it in every **copy**, a folder holding that `apl.json`. Approvals are per user, in `~/.apl/approvals.json`, and belong to the **place** they were given in: a project, the user scope, or a named folder. The owner is asked again in each new place and when the command text changes. Two branches below: the author's and the machine owner's.

## Author: add `apl.json`

1. Place it where the setup is needed: in a skill folder beside `SKILL.md` (`skills/<name>/apl.json`, reaches every deployed copy of the skill), or at the plugin root, beside `plugin.json` or beside `.claude-plugin/` and never inside it (reaches the plugin's native copy `.agents/plugins/<name>/`). An `apl.json` at the root of a repository of plain skills reaches no skill copy, only APM's cache, and is reported `skipped`; one under `.apm/` is stripped by APM.
2. Write the one script:

   ```json
   { "scripts": { "install": "npm ci" } }
   ```

   - It runs through the platform shell (`sh`, or `cmd.exe` on Windows) exactly as written, in the folder that holds `apl.json`, with standard input closed. For anything beyond one portable command, call a script: `node setup.js`.
   - It must be safe to repeat: it runs again in each copy when that copy's files change or the copy is recreated.
   - npm in a **native plugin copy** (`.agents/plugins/<name>/`) needs `--no-bin-links`: APM refuses later installs of a plugin copy containing a symlink, which `node_modules/.bin` adds. Plain skill copies work with standard `npm ci`.
   - Unknown fields are ignored; only `scripts.install` runs, and a named folder without it is `failed …: apl.json has no scripts.install`. Editing the command makes every user approve it again.

Done when `apl install -y <folder>` on a local copy prints `ran` and `apl status <folder>` prints `ok`.

## Machine owner: register, approve, check

1. Install: `npm install -g agent-plugin-lifecycle` (Node.js 22.18 or newer; the command is `apl`, also `agent-plugin-lifecycle`; the npm name `apl` is someone else's package).
2. With APM, register it once in the user `~/.apm/apm.yml`; the entry fires for project and `-g` installs alike, and on every update:

   ```yaml
   name: my-machine
   version: 0.0.0
   lifecycle:
     post-install:
       - run: apl install
         timeoutSec: 300
   ```

   - `timeoutSec` is needed: APM kills a lifecycle command after 30 seconds by default, and also kills a command whose output exceeds 1 MiB per stream — exiting 0 either way.
   - In a script or scheduled job, you can omit APM's lifecycle entry and run `apl install` (or `apl install -g`) yourself after `apm` so `apl`'s lines and exit code reach the job directly without APM's time or output limits.
   - APM strips credential-looking variables (`NPM_TOKEN`, `*_API_KEY`, ...); list any a script needs as `allowedEnvVars: [NPM_TOKEN]` on the entry.
   - `apm lifecycle` lists the entry once it is registered.
   - APM's run has no terminal: it runs approved scripts and only reports unapproved ones, as `[!] Lifecycle post-install command script exited with code 1; continuing. Output: ~/.apm/logs/scripts.log`. That line means a script waits for approval: step 3.
3. Approve: after the first `apm install` in each project, run `apl install` yourself in the project root (or `apl install -g` for a user install); an approval given in one project, or at user scope, never applies in another. It shows each id, the command and its folders and asks `Run it? [y/N]`; all questions come first and the approvals are saved after the last, so Ctrl+C saves nothing. `-y` approves everything unapproved at that moment without asking and saves it (CI). An agent without a terminal reads `scripts.install` from `<folder>/apl.json` for each `unapproved <id> <folder>` line of `apl status`, shows the owner each id with that command, and runs `apl install -y` in that same place only on the owner's go-ahead: approving is the owner's decision.
4. With the skills CLI, name the folders it created: `npx skills add team/skills --skill report -a claude-code -a codex` writes `.agents/skills/report` and links `.claude/skills/report` to it (one copy), so `apl install .agents/skills/report .claude/skills/report`; with `-g`, the same folders under the home. After `npx skills update`, run that `apl install` again: there is no hook. Any other installer or a copy by hand: name its folders the same way. A named folder runs every time it is named.
5. Check: `apl status` (or `-g`, or folders) after any APM command that automation relies on, since APM exits 0 when a lifecycle command fails.

Done when `apl status` exits 0.

## Reading `apl` output

Read results from `apl status`, or from the standard output of `apl install`, which holds only `apl`'s lines (scripts print to standard error). Each line is printed as its result is known. An id or folder that holds a space or unusual characters prints as a JSON string (it starts with `"`): decode it before using it as a path.

| Line | What to do |
|---|---|
| `ran`, `current`, `ok` | Nothing. |
| `unapproved <id> <folder>` | New or changed command: the owner approves it with `apl install` (answer `y`) or `apl install -y`. |
| `missing <id> <folder>` | Approved but never succeeded here: run `apl install` and read the script's output. |
| `stale <id> <folder>` | Succeeded for older files, an older command, or a recreated folder: run `apl install`. |
| `failed <id> <folder>: <reason>` | `exit code N` is the script failing; `resolves to …, outside …` is a folder or `apl.json` linking out of the scope (never run); `copies of <id> disagree on install` is copies with different commands; `apl.json has no scripts.install` or `no apl.json` is a named folder without a script; a lock path as the folder is a lock row `apl` cannot use (the reason names the field); otherwise `apl.json` is invalid. Fix the cause, then `apl install`. |
| `skipped <id> <folder>: APM's cache is the only copy; scripts do not run there` | That `apl.json` reaches no folder APM deployed (a commands-only plugin installed for Copilot, a root `apl.json` of a repository of plain skills, or a lock entry or link into `apm_modules`), so it never runs. Not counted against the exit code; the author moves `apl.json` to a deployed folder. |
| `left <folder>` | APM removed the package but kept this folder, because it holds files APM did not write. Delete it by hand. |

Exit codes: 0 all fine (`skipped` and `left` do not count), 1 a copy needs attention, 2 `apl` could not work (bad arguments, unreadable lock, unwritable `~/.apl`, a `~/.apl` not owned by the user or writable by group or others (`chmod go-w`), or `no apm.lock.yaml here: pass -g or a folder`), 130 Ctrl+C at the question (nothing saved or run).

An id is `<host>/<repo>[/<path>][:<folder>]` for a Git source, the absolute source path plus `:<folder>` for a local one, the folder's real path for a named folder. A place is the real path of the project folder, of the APM home (`-g`), or of the named folder. `~/.apl/approvals.json` holds `approvals.<place>.<id>` with `scripts.install` and `approved`; to revoke an approval, delete that entry.

More setups: [EXAMPLES.md](EXAMPLES.md).
