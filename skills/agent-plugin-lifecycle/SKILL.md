---
name: agent-plugin-lifecycle
description: "Run a plugin's own setup and cleanup commands when Agent Package Manager (APM) installs, updates or removes it: install its dependencies (npm ci, uv sync, any language) in every deployed copy, and clean up after removal. Use when an APM-installed plugin or skill needs dependencies or setup, when writing or changing ~/.config/agent-plugin-lifecycle/config.json, when registering lifecycle hooks in ~/.apm/apm.yml, or when checking whether a plugin's setup succeeded."
---

# agent-plugin-lifecycle

APM installs a plugin and copies it into each harness: a native plugin copy under `~/.agents/plugins/` and copies of its skills (`~/.agents/skills`, `~/.claude/skills`, `~/.hermes/skills`), plus its own kept copy under `~/.apm/apm_modules/`. APM never runs a plugin's own code. `agent-plugin-lifecycle` is the machine owner's hook: APM calls it after each install, update and removal, and it runs the commands the owner configured for that plugin in each copy a harness reads. It leaves APM's kept copy alone unless that is the only copy (Copilot reads it in place), because a file written there makes the next `apm update` restore APM's cache and fire its events again. Commands come only from the owner's config, never from downloaded plugin files.

## Set up a machine

1. Install the CLI (Node.js 22.18 or newer):

   ```sh
   npm install -g agent-plugin-lifecycle
   ```

2. Register it for the three events in the user `~/.apm/apm.yml` (create the `lifecycle` block, or add these entries to an existing one). APM requires `name` and `version` in that file before the first install:

   ```yaml
   name: my-machine
   version: 0.0.0
   lifecycle:
     post-install:
       - run: agent-plugin-lifecycle run
         timeoutSec: 300
     post-update:
       - run: agent-plugin-lifecycle run
         timeoutSec: 300
     post-uninstall:
       - run: agent-plugin-lifecycle run
         timeoutSec: 300
   ```

   - `timeoutSec` (seconds) is needed: APM kills a lifecycle command after 30 seconds by default and still exits 0. One entry runs all configured commands for the event, so size it for all of them.
   - APM drops credential-looking environment variables (`NPM_TOKEN`, `*_API_KEY`, `*_PASSWORD`, ...) from lifecycle commands; list any the commands need on the entry: `allowedEnvVars: [NPM_TOKEN]`.
   - Write SSH dependencies in `apm.yml` as the full `git@host:owner/repo.git` URL; the short `host/owner/repo` form that `apm install --ssh` writes is fetched over HTTPS later.

Done when `agent-plugin-lifecycle --help` prints its usage and `~/.apm/apm.yml` has `name`, `version` and all three entries with `timeoutSec`.

## Configure a plugin

Add one record per plugin, or per skill inside it, to `~/.config/agent-plugin-lifecycle/config.json`:

```json
{
  "version": 1,
  "plugins": [
    {
      "source": "git@github.com:team/plugins.git",
      "path": "plugins/example",
      "post-install": "npm ci --prefix server --no-bin-links",
      "post-uninstall": "node .config/agent-plugin-lifecycle/cleanup-example.js"
    },
    {
      "source": "git@github.com:team/plugins.git",
      "path": "plugins/example",
      "skill": "hello-py",
      "post-install": "uv sync"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `source` | The plugin's source exactly as `apm.yml` names it: a Git URL, or the absolute local path. |
| `path` | The plugin's folder inside that repository; `.` (the default) is the repository root. |
| `skill` | Optional. The record applies to each deployed copy of that one skill (`skills/<name>`) instead of the whole plugin. |
| `post-install` | Runs in each deployed copy after install. |
| `post-update` | Runs in each deployed copy after update. Defaults to `post-install`, so most records write the installer once. |
| `post-uninstall` | Runs once after APM removes the plugin. |

Rules for the commands:

- A command is a string like an npm script, run through the platform shell (`sh`, or `cmd.exe` on Windows) with the copy as its working directory. Write it for that machine's shell.
- A command must be safe to repeat, as `npm ci` and `uv sync` are: it runs again whenever APM changes the plugin or recreates a copy. A copy where the same command already succeeded for the locked revision is skipped (`current`), so an update with nothing new runs nothing.
- APM runs the command after writing the new files into the copy and waits for it. Until it finishes, the copy has the new files beside the previous packages, and an `npm ci` leaves it without packages while it reinstalls (only when the plugin changed).
- Use `npm ci --no-bin-links` (or `npm_config_bin_links=false`). APM fingerprints the Claude Code plugin copy and refuses later installs when that copy contains a symlink, which `node_modules/.bin` would add. Keep other symlinks out of deployed copies the same way.
- `post-uninstall` runs from the home folder after the plugin's files are gone, so it calls a file the owner keeps outside the plugin.

For a repository of plain skills (`skills/<name>/SKILL.md`, no plugin manifest), select the skills on its `apm.yml` entry with `skills: [name]` (what `apm install owner/repo --skill name` writes), and give each skill a record with `source` and `skill` and no `path`.

Then run `apm install` (or `apm update`) as usual; the commands run inside it.

`apm update` moves a pinned source only to a newer release tag and then fires `post-update`. For a source without release tags, change the pin and run `apm install --update`; that fires `post-install`, and the commands still run because `post-update` defaults to `post-install`.

## Check a machine

```sh
agent-plugin-lifecycle check
```

It prints one line per copy of every installed, configured record and exits 1 unless all are `ok`: `ok` (the current command succeeded for the locked revision), `missing` (never succeeded there), `stale` (succeeded for an older revision or command), `broken` (succeeded, but the copy is gone). With nothing installed it prints `nothing installed` and exits 0. APM exits 0 even when a hook fails or times out, so run `check` after every APM command that automation relies on:

```sh
apm update -g --yes && agent-plugin-lifecycle check
```

`check` does not look inside a copy: packages deleted from it by hand are not detected.

## Uninstall leftovers

APM keeps a copy's folder when it still holds files APM did not write (the `node_modules` a command made). The hook prints `left <path>` for each such copy before the record's `post-uninstall` command, and deletes nothing; remove them by hand or from `post-uninstall`.

To fix a failed record: correct the command in `config.json`, then run `apm install` again; the commands run again and `check` turns clean.

More configurations: [EXAMPLES.md](EXAMPLES.md).
