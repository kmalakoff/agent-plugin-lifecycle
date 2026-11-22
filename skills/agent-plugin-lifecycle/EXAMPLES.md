# agent-plugin-lifecycle examples

## A plugin with an MCP server and a Node skill

The plugin `plugins/notes` in `git@github.com:team/plugins.git` has an MCP server in `server/` with its own `package.json`, and a skill `notes-search` with a script that needs dependencies.

`~/.apm/apm.yml`:

```yaml
dependencies:
  apm:
    - git: git@github.com:team/plugins.git
      path: plugins/notes
      ref: v1.4.0
lifecycle:
  post-install:
    - run: agent-plugin-lifecycle run
  post-update:
    - run: agent-plugin-lifecycle run
  post-uninstall:
    - run: agent-plugin-lifecycle run
```

`~/.config/agent-plugin-lifecycle/config.json`:

```json
{
  "version": 1,
  "plugins": [
    {
      "source": "git@github.com:team/plugins.git",
      "path": "plugins/notes",
      "post-install": "npm ci --prefix server --no-bin-links"
    },
    {
      "source": "git@github.com:team/plugins.git",
      "path": "plugins/notes",
      "skill": "notes-search",
      "post-install": "npm ci --no-bin-links"
    }
  ]
}
```

The first record installs the server's dependencies in each full plugin copy, so the server starts in every harness that registered it. The second installs the skill's dependencies in each copy of `notes-search`.

## A Python skill

```json
{
  "source": "git@github.com:team/plugins.git",
  "path": "plugins/reports",
  "skill": "monthly-report",
  "post-install": "uv sync --frozen"
}
```

## A repository of plain skills

The repository `https://github.com/team/skills.git` holds `skills/<name>/SKILL.md` folders and no plugin manifest. Install one of its skills, `report`:

```yaml
dependencies:
  apm:
    - git: https://github.com/team/skills.git
      skills:
        - report
```

```json
{
  "source": "https://github.com/team/skills.git",
  "skill": "report",
  "post-install": "npm ci --no-bin-links"
}
```

## A local plugin with cleanup

A plugin kept in a local folder is declared in `apm.yml` by its absolute path, and the record uses the same path:

```json
{
  "source": "/opt/plugins/backup",
  "post-install": "npm ci --no-bin-links",
  "post-uninstall": "node .config/agent-plugin-lifecycle/backup-cleanup.js"
}
```

`backup-cleanup.js` lives outside the plugin, so it still exists when the cleanup runs.
