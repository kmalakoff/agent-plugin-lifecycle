# Changelog

All notable changes to agent-plugin-lifecycle are documented here.

## [0.3.1] - 2026-11-27

### Fixed

- Changing one skill in a repository of skills now re-runs only that skill (using the per-file hashes APM records in `deployed_file_hashes`), leaving unchanged sibling skills `current`.
- A copy folder that APM (or another installer) deleted and re-created now runs its script again (`apl status` reports it `stale` until `apl install` runs).
- Fewer `skipped` lines: unselected skills in a repository installed with APM's `skills` filter (`skill_subset`) are no longer reported `skipped`.

### Changed

- Upgrading from 0.3.0: the first `apl install` runs each approved script once more to record the copy stamp (until then `apl status` reports approved copies as `stale`).
- At project scope, APM re-creates native plugin folders on every `apm install` (so `apl` runs their scripts again each time) and on `apm uninstall` without firing `post-install` (leaving remaining native plugins `stale` until `apl install`).

## [0.3.0] - 2026-11-26

A clean break: scripts now ship with the plugin or skill, and the machine owner approves them.

### Added

- `apl.json` in a skill folder or a plugin root, with one script, `scripts.install`. It runs after the plugin or skill is installed and after it is updated, in every copy an installer deployed.
- The `apl` command (`agent-plugin-lifecycle` stays as a second name): `apl install [-g] [-y] [folder...]` asks every question before running any script it has not approved and saves the approvals after the last answer, and `apl status [-g] [folder...]` reports each copy (`ok`, `missing`, `stale`, `unapproved`, `failed`, `skipped`, `left`). Each line is printed as its result is known; scripts print to standard error, so standard output holds only these lines. An approval belongs to the place it was given in (a project, the user scope, or a named folder) and never applies in another; approvals and run records live in `~/.apl/`, and you are asked again in a new place or when a command changes.
- Project-scope APM installs: one `post-install` entry in the user `~/.apm/apm.yml` calls `apl install` (APM fires `post-install` on every update too), which uses `./apm.lock.yaml` in a project and `~/.apm/apm.lock.yaml` for `-g`.
- Folders installed without APM (the skills CLI `npx skills add`, by hand): `apl install <folder>`. A named folder without `scripts.install` is `failed`; a folder named twice, also through a link, runs once.
- The copies come from APM's own record in the lock (`deployed_files` and `native_plugin.root`), so a skill folder APM deployed anywhere, including under a moved `CLAUDE_CONFIG_DIR`, is found. Scripts never run in APM's cache (`apm_modules/`), which APM restores on `apm update`, also when a lock entry or link points into it; an `apl.json` there that no deployed folder carries is reported `skipped`, which does not change the exit code. A lock row is checked only for the fields `apl` uses, and a row it cannot use fails alone.
- On macOS and Linux, `apl` stops with exit 2 when `~/.apl` or a file in it is not owned by the user or is writable by group or others. Everything printed from untrusted input is escaped, the exit-2 error message included.

### Removed

- The owner config file `~/.config/agent-plugin-lifecycle/config.json`, `config/config.example.json`, and its commands per plugin. Nothing reads them.
- The `run` and `check` commands, the APM event on standard input, and the `post-uninstall` command. `left` lines from `apl status` replace the uninstall report.
- The 0.2.0 state file (`~/.config/agent-plugin-lifecycle/state.json`); records are not carried over.
- The library exports `runLifecycle`, `parseConfig`, `recordId`, `parseLock`, `matchesSource` and `sourceParts`; the package now exports `install` and `status`.

### Upgrading from 0.2

Once on each machine that ran 0.2.0:

1. In `~/.apm/apm.yml`, replace the three `agent-plugin-lifecycle run` entries with the one `post-install` entry that runs `apl install`, as in the README.
2. For each plugin or skill that had a record in `~/.config/agent-plugin-lifecycle/config.json`, add an `apl.json` with that command to the plugin's own repository.
3. Delete `~/.config/agent-plugin-lifecycle/`.
4. Run `apl install -g` once and approve, then `apl install` once in each project that installs with APM.

## [0.2.0] - 2026-11-22

### Changed

- An `apm update` with nothing new runs no command. A copy where the same command already succeeded for the revision APM has locked (commit and content hash) is skipped and printed as `current`, and a changed plugin runs its command once per copy, though APM fires both `post-install` and `post-update`.
- Commands no longer run in APM's kept copy under `~/.apm/apm_modules/` when the lock names another copy (a native plugin folder or deployed skill folders). A file written there made every later `apm update` restore APM's cache and fire its events again. A plugin whose only copy is the kept one (Copilot) still runs there.
- `check` prints `ok`, `missing`, `stale` (succeeded for an older revision or command) or `broken` (the copy is gone) per copy, and exits 1 unless all are `ok`. With nothing installed, including after a full `apm uninstall`, it prints `nothing installed` and exits 0 instead of failing on the missing lock file.
- `post-uninstall` prints `left <path>` for each copy APM kept because it still holds files APM did not write, such as `node_modules`. Nothing is deleted.
- The state file moves to version 2. Version 1 receipts are still read; the first install or update after upgrading runs each command once more in every copy to record its revision.

### Fixed

- The README now covers what a working setup needs: `name` and `version` in the user `apm.yml`, `timeoutSec` on each lifecycle entry (APM kills a command after 30 seconds by default and still exits 0), `allowedEnvVars` for credential-looking variables, full `git@host:owner/repo.git` SSH URLs, when APM runs the commands, and running `check` after every APM command.

## [0.1.1] - 2026-11-22

### Changed

- The README documents repositories of plain skills and when `apm update` fires `post-update`. No code change.

## [0.1.0] - 2026-11-21

### Added

- First release. `agent-plugin-lifecycle run` is the APM hook for post-install, post-update and post-uninstall: it runs the commands configured in `~/.config/agent-plugin-lifecycle/config.json` in every copy of a plugin or skill that APM deployed, and `agent-plugin-lifecycle check` reports whether each copy's last install or update command succeeded.
