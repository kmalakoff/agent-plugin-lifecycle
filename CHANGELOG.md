# Changelog

All notable changes to agent-plugin-lifecycle are documented here.

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
