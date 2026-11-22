# Changelog

All notable changes to agent-plugin-lifecycle are documented here.

## [0.1.0] - 2026-11-21

### Added

- First release. `agent-plugin-lifecycle run` is the APM hook for post-install, post-update and post-uninstall: it runs the commands configured in `~/.config/agent-plugin-lifecycle/config.json` in every copy of a plugin or skill that APM deployed, and `agent-plugin-lifecycle check` reports whether each copy's last install or update command succeeded.
