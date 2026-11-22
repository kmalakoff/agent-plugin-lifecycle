# agent-plugin-lifecycle

Run your own setup and cleanup commands when Agent Package Manager (APM) installs, updates or removes an agent plugin. APM copies a plugin into each agent harness but never runs the plugin's own code, so a plugin that needs `npm ci`, `uv sync` or any other setup arrives without it. `agent-plugin-lifecycle` is the hook APM calls after each event: it finds every copy APM deployed, runs the commands you configured for that plugin in each copy that needs it, and records whether they succeeded. Commands come only from your own config file, never from downloaded plugin files.

Requires Node.js 22.18 or newer and APM.

## Install

```sh
npm install -g agent-plugin-lifecycle
agent-plugin-lifecycle --help
```

## Register the hook with APM

Add the dispatcher to your user `~/.apm/apm.yml` (or `$APM_HOME/apm.yml`) for each event you want:

```yaml
name: my-machine          # APM requires name and version before the first install
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
dependencies:
  apm:
    - git: git@bitbucket.org:team/plugins.git
      path: plugins/example
```

- **`timeoutSec`**: APM stops a lifecycle command after 30 seconds unless the entry sets `timeoutSec` (seconds), kills it with everything it started, and still exits 0. One entry runs every configured command for the event, so give it enough time for all your installs.
- **SSH sources**: write the full `git@host:owner/repo.git` URL in `apm.yml`. The short `host/owner/repo` form that `apm install --ssh` writes is fetched over HTTPS on later runs.
- **Secrets**: APM removes environment variables whose names look like credentials (`NPM_TOKEN`, `*_API_KEY`, `*_PASSWORD` and similar) from lifecycle commands. If your commands need one, list it on the entry: `allowedEnvVars: [NPM_TOKEN]`.

The dispatcher handles user-scope events; project-scope events are skipped.

## Configure plugins

Put your commands in `~/.config/agent-plugin-lifecycle/config.json`:

```json
{
  "version": 1,
  "plugins": [
    {
      "source": "git@bitbucket.org:team/plugins.git",
      "path": "plugins/example",
      "post-install": "npm ci --prefix server --no-bin-links",
      "post-uninstall": "node .config/agent-plugin-lifecycle/cleanup-example.js"
    },
    {
      "source": "git@bitbucket.org:team/plugins.git",
      "path": "plugins/example",
      "skill": "hello-node",
      "post-install": "npm ci --no-bin-links"
    }
  ]
}
```

Each record names one plugin or skill:

| Field | Meaning |
|---|---|
| `source` | Git URL, or the absolute local path written in the plugin's `apm.yml` dependency |
| `path` | Relative folder of the plugin inside the repository; default `.` |
| `skill` | Run in each deployed copy of this skill instead of the whole plugin |
| `post-install` | Runs in each deployed copy after install |
| `post-update` | Runs in each deployed copy after update; defaults to `post-install` |
| `post-uninstall` | Runs once after APM removes the plugin |

A repository of plain skills (`skills/<name>/SKILL.md`, no plugin manifest) works the same way: select the skills on its `apm.yml` entry with `skills: [name]` (what `apm install owner/repo --skill name` writes), and give each one a record with `source` and `skill`, no `path`:

```json
{ "source": "https://github.com/team/skills.git", "skill": "report", "post-install": "npm ci --no-bin-links" }
```

A full example is in [config/config.example.json](config/config.example.json).

Then run `apm install` or `apm update` as usual; your commands run inside it.

APM fires `post-update` when `apm update` moves a pinned source to a newer release tag. A source pinned to a commit in a repository without release tags does not move on `apm update`: change the pin and run `apm install --update`, which fires `post-install`. Either way your commands run, because `post-update` defaults to `post-install`.

## Where and when the commands run

A command runs in each copy a harness reads: the skill folders APM deployed (`~/.agents/skills`, `~/.claude/skills`, `~/.hermes/skills`) and the native plugin folder (`~/.agents/plugins/<name>`). APM's own kept copy under `~/.apm/apm_modules/` is left alone, because a file written there makes the next `apm update` restore its cache and fire its events again. The one exception is a plugin whose only copy is the kept one (a target such as Copilot reads it in place); there the command runs in the kept copy.

A copy is skipped (`current` in the output) when the same command already succeeded there for the revision APM has locked (its commit and content hash). So an `apm update` with nothing new runs no command, and a changed plugin runs its command once per copy, even though APM fires both `post-install` and `post-update`.

APM runs the command after it has written the new plugin files into the copy, and waits for it to finish before the APM command returns. For that time the copy holds the new files next to the packages from the previous version, and if the command deletes and rebuilds them, as `npm ci` does, the copy has no packages until it finishes: a fraction of a second to a few seconds per copy, only when the plugin changed. A command may build its packages in another folder and rename them into place to shorten that gap; two renames still leave a short one.

## Check the result

Each time it runs your command in a copy, `agent-plugin-lifecycle` records whether the command exited successfully there. `agent-plugin-lifecycle check` prints that record, one line per copy, and exits 1 if any copy is not `ok`:

```sh
agent-plugin-lifecycle check
```

| Status | Meaning |
|---|---|
| `ok` | Your current command succeeded in this copy for the version APM has installed |
| `missing` | It has not succeeded in this copy |
| `stale` | It last succeeded for an older version of the plugin, or an older command |
| `broken` | It succeeded, but the copy is gone |

With nothing installed it prints `nothing installed` and exits 0. It reports only what your commands did; it does not test the plugin itself.

Why it exists: when your command fails or runs past its `timeoutSec`, APM prints a warning and still exits 0, so a script cannot tell from APM alone. Run `check` after `apm install` or `apm update` in a script or scheduled job:

```sh
apm update -g --yes && agent-plugin-lifecycle check
```

When you run APM yourself and read its output, you do not need it. To fix a failed copy, correct the command and run `apm install` again.

## Uninstall

APM keeps a skill or plugin folder that still holds files it did not write, such as the `node_modules` your command made, and says so. Before running the record's `post-uninstall` command, the dispatcher prints `left <path>` for each such copy; it deletes nothing. Remove those folders yourself, or have `post-uninstall` remove them.

## Rules for commands

- A command is a string run through the platform shell (like an npm script), exactly as written; nothing from APM or the plugin is substituted into it. Quoting and syntax follow that machine's shell.
- Make each command safe to repeat: it runs again whenever APM changes the plugin, and whenever a copy is recreated.
- For npm inside a Claude Code plugin copy use `--no-bin-links` (or `npm_config_bin_links=false`). APM refuses later installs when that copy contains a symlink, and `node_modules/.bin` would add one.
- A local `source` is the absolute path exactly as written in `apm.yml`.
- `post-uninstall` runs from your home folder after the plugin's files are gone, so it can only use files you keep outside the plugin.

## Upgrading from 0.1

The first `apm install` or `apm update` after upgrading runs each command once more in every copy, to record the locked revision; after that, unchanged copies are skipped. Commands no longer run in APM's kept copy when another copy exists; a `node_modules` folder an earlier version left there can be deleted.

## Agent skill

```sh
npx skills add kmalakoff/agent-plugin-lifecycle   # -g for global, -a <agent> to target
```

The skill teaches an agent to set up this hook, write the config for a plugin and check the result. It installs from Git through this command, separately from the npm package.

## License

MIT
