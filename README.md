# agent-plugin-lifecycle

Run your own setup and cleanup commands when Agent Package Manager (APM) installs, updates or removes an agent plugin. APM copies a plugin into each agent harness but never runs the plugin's own code, so a plugin that needs `npm ci`, `uv sync` or any other setup arrives without it. `agent-plugin-lifecycle` is the hook APM calls after each event: it finds every copy APM deployed, runs the commands you configured for that plugin in each copy, and records whether they succeeded. Commands come only from your own config file, never from downloaded plugin files.

Requires Node.js 22.18 or newer and APM.

## Install

```sh
npm install -g agent-plugin-lifecycle
agent-plugin-lifecycle --help
```

## Register the hook with APM

Add the dispatcher to your user `~/.apm/apm.yml` for each event you want:

```yaml
lifecycle:
  post-install:
    - run: agent-plugin-lifecycle run
  post-update:
    - run: agent-plugin-lifecycle run
  post-uninstall:
    - run: agent-plugin-lifecycle run
```

It handles user-scope events; project-scope events are skipped.

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

## Check the result

```sh
agent-plugin-lifecycle check
```

Prints `ok` or `missing` for every deployed copy of every installed, configured record, and exits 1 if any copy is `missing` (the current command never succeeded there). APM reports a failing hook as a warning and still finishes, so use `check` wherever a script needs a definite answer. To fix a record, correct its command and run `apm install` again.

## Rules for commands

- A command is a string run through the platform shell (like an npm script), exactly as written; nothing from APM or the plugin is substituted into it. Quoting and syntax follow that machine's shell.
- Make each command safe to repeat: it runs on every install and update.
- For npm inside a Claude Code plugin copy use `--no-bin-links` (or `npm_config_bin_links=false`). APM refuses later installs when that copy contains a symlink, and `node_modules/.bin` would add one.
- A local `source` is the absolute path exactly as written in `apm.yml`.
- `post-uninstall` runs from your home folder after the plugin's files are gone, so it can only use files you keep outside the plugin.

## Agent skill

```sh
npx skills add kmalakoff/agent-plugin-lifecycle   # -g for global, -a <agent> to target
```

The skill teaches an agent to set up this hook, write the config for a plugin and check the result. It installs from Git through this command, separately from the npm package.

## License

MIT
