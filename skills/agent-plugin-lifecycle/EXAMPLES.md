# agent-plugin-lifecycle examples

## A plugin with an MCP server and a Node skill

The plugin `plugins/notes` has an MCP server in `server/` with its own `package.json`, and a skill `notes-search` whose script needs dependencies. Two files in the plugin's repository:

`plugins/notes/apl.json` (runs in the plugin's native copy):

```json
{ "scripts": { "install": "npm ci --prefix server --no-bin-links" } }
```

`plugins/notes/skills/notes-search/apl.json` (runs in each copy of the skill):

```json
{ "scripts": { "install": "npm ci --no-bin-links" } }
```

The owner's first install, from the project root:

```sh
apm install && apl install
```

`apl install` asks twice, once for `github.com/team/plugins/plugins/notes` and once for `github.com/team/plugins/plugins/notes:skills/notes-search`, then prints a `ran` line per copy. In another project that uses the same plugin, `apl install` asks again: an approval belongs to the project it was given in.

## A Python skill

`skills/monthly-report/apl.json`:

```json
{ "scripts": { "install": "uv sync --frozen" } }
```

## A setup that needs more than one command

Keep the logic in a script beside `apl.json`, so it behaves the same under `sh` and `cmd.exe`:

```json
{ "scripts": { "install": "node setup.js" } }
```

## A skill installed with the skills CLI

`npx skills add team/skills --skill report -a claude-code -a codex` wrote the skill, `apl.json` included, to `.agents/skills/report` and linked `.claude/skills/report` to it. Name both folders; the link resolves to the same folder, so `apl install` asks once and prints one line, and the folder stays approved from whatever folder you name it:

```sh
apl install .agents/skills/report .claude/skills/report
apl status .agents/skills/report .claude/skills/report
```

After `npx skills update`, run the same `apl install` again: the skills CLI has no hook, and a named folder's script runs every time it is named.

## CI

A job that installs a project's APM dependencies and needs their setup to have run:

```sh
apm install && apl install -y && apl status
```

`-y` approves every script in that job's fresh home; the last command exits 1 if any copy is not `ok`.

## After `apm uninstall`

```console
$ apl status -g
ok github.com/team/skills:skills/report /Users/me/.agents/skills/report
left /Users/me/.agents/plugins/notes
```

APM kept `/Users/me/.agents/plugins/notes` because the script's `node_modules` are files APM did not write. Delete the folder; `apl status` then no longer lists it.
