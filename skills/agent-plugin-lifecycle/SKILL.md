---
name: agent-plugin-lifecycle
description: "Run a plugin's own setup and cleanup commands when Agent Package Manager (APM) installs, updates or removes it: install its dependencies (npm ci, uv sync, any language) in every deployed copy, and clean up after removal. Use when an APM-installed plugin or skill needs dependencies or setup, when writing or changing ~/.config/agent-plugin-lifecycle/config.json, when registering lifecycle hooks in ~/.apm/apm.yml, or when checking whether a plugin's setup succeeded."
---

# agent-plugin-lifecycle

APM installs a plugin and copies it into each harness: a kept copy under `~/.apm/apm_modules/`, a native Claude Code plugin copy, and copies of its skills. APM never runs a plugin's own code. `agent-plugin-lifecycle` is the machine owner's hook: APM calls it after each install, update and removal, and it runs the commands the owner configured for that plugin, in every copy APM deployed. Commands come only from the owner's config, never from downloaded plugin files.

## Set up a machine

1. Install the CLI (Node.js 22.18 or newer):

   ```sh
   npm install -g agent-plugin-lifecycle
   ```

2. Register it for the three events in the user `~/.apm/apm.yml` (create the `lifecycle` block, or add these entries to an existing one):

   ```yaml
   lifecycle:
     post-install:
       - run: agent-plugin-lifecycle run
     post-update:
       - run: agent-plugin-lifecycle run
     post-uninstall:
       - run: agent-plugin-lifecycle run
   ```

Done when `agent-plugin-lifecycle --help` prints its usage and `~/.apm/apm.yml` has all three entries.

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
- A command must be safe to repeat, as `npm ci` and `uv sync` are: it runs on every install and update, also when APM recreates a copy at the same revision.
- Use `npm ci --no-bin-links` (or `npm_config_bin_links=false`). APM fingerprints the Claude Code plugin copy and refuses later installs when that copy contains a symlink, which `node_modules/.bin` would add. Keep other symlinks out of deployed copies the same way.
- `post-uninstall` runs from the home folder after the plugin's files are gone, so it calls a file the owner keeps outside the plugin.

Then run `apm install` (or `apm update`) as usual; the commands run inside it.

## Check a machine

```sh
agent-plugin-lifecycle check
```

It prints `ok` or `missing` for every deployed copy of every installed, configured record (`missing`: the current command never succeeded there), and exits 1 when any copy is `missing`. APM reports a failing hook as a warning and still finishes, so use `check` wherever automation needs a definite answer, for example after a scripted `apm install`.

To fix a failed record: correct the command in `config.json`, then run `apm install` again; the commands run again and `check` turns clean.

More configurations: [EXAMPLES.md](EXAMPLES.md).
