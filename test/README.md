# Tests

Four layers exercise one code path (`install` and `status`, and the built CLI over them). Which layer proves what:

| Layer | Files | Needs | Proves |
| --- | --- | --- | --- |
| Package tests | `test/unit` (mirrors `src/`), `test/integration/cli.test.ts`, `test/exports` | Node only | `apl.json` checks, ids, approvals, run records, the locked store, running a script, and the built CLI's lines and exit codes against a disposable home under `.tmp/`, started as APM starts it (no terminal, in a project root and in the APM home). The terminal question is tested through the `approve` option. |
| Recorded replays | `test/integration/apm-recorded.test.ts` | Node only | apl handles the lock files and deployed folders of **real APM runs** saved in `test/fixtures/apm/<apm-version>/<os>/`, on every OS, every run. |
| Live APM | `test/integration/apm-live.test.ts` | `apm` on `PATH`; the Git scenarios also need the network | The installed `apm` deploys the test plugins' `apl.json`, its one `post-install` entry in the user `apm.yml` runs the built `apl install` on installs and updates, and the scripts run, at user and project scope; for three public GitHub repositories apl finds every copy APM deployed (a package APM deployed nowhere but its cache is reported `skipped`), and with `CLAUDE_CONFIG_DIR` outside the home or at a non-default folder inside it, apl runs the script in the skill folder APM recorded there. The lock shapes and the events of each step still match the recordings. |
| Live skills CLI | `test/integration/skills-cli.test.ts` | the network | `npx skills add` (skills CLI 1.9.1, `vercel-labs/skills` at `v1.2.0`) writes one copy under `.agents/skills` and links `.claude/skills` to it, at project and user (`-g`) scope, as the README says; the built `apl` on those folders reports `unapproved` without `-y`, runs the copy once with `-y`, and `apl status` is `ok`. |

No layer simulates APM: every lock file a test reads comes from a recording or from the live run, except the hostile values of the security tests, which no APM run produces. Nothing touches your real account. The live suite gives APM and apl a disposable home under `.tmp/` and sets `HOME`, `USERPROFILE`, `HOMEDRIVE`/`HOMEPATH`, `APM_HOME`, `APM_CACHE_DIR`, `APM_TEMP_DIR`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `CLAUDE_CONFIG_DIR`, `COPILOT_HOME`, `CODEX_HOME`, `HERMES_HOME`, `LOCALAPPDATA`, `APPDATA`, `TMPDIR`/`TMP`/`TEMP` and `GIT_CONFIG_GLOBAL` there (`test/lib/apm-live.ts`, `isolatedEnvironment`). Only `PATH` and the Windows system variables come from the real environment. Whether that keeps every APM write inside `.tmp/` on macOS and Windows has not been verified; the `APM` workflow's runs will show it.

## Run locally

```sh
npm test                                   # everything; the live APM suite is skipped when apm is not on PATH
npx tsds test:node --no-timeouts test/integration/apm-recorded.test.ts   # one file
```

You never need APM to develop. If you do have it installed, the live suite runs on its own and still writes only under `.tmp/`.

| Setting | Effect |
| --- | --- |
| `TEST_APM_STRICT=true` | A missing `apm` fails the live suite instead of skipping it. The `APM` workflow (`.github/workflows/apm.yml`) sets it; that job owns this coverage. |
| `TEST_APM_VERSION=x.y.z` | The `apm` on `PATH` must report exactly this version. No workflow sets it; the Docker recording below does. |
| `TEST_APM_RECORD=true` | The live run also writes `test/fixtures/apm/<apm-version>/<os>/` from what APM did. |
| `TEST_SKILLS_STRICT=true` | No network fails the live skills CLI suite instead of skipping it. The `APM` workflow sets it (`npm run test:skills`). |

## CI

Both workflows run on push to `master` only.

- `main.yml` (`CI`): the house workflow, unchanged. It runs the package tests and the recorded replays; the live APM suite skips there because no `apm` is installed.

The live skills CLI suite is in default discovery and needs the network: every `npm test` runs it live against the npm registry and GitHub, so `main.yml` runs it too (in `npm run test` and once per engine in `npm run test:engines`). Outside the `APM` workflow it is not strict: it skips only when the network is absent (a name that does not resolve, no route), and a registry or GitHub that answers with a refusal fails it.
- `apm.yml` (`APM`): installs the **latest** APM release with its official installer, runs the live suite with `TEST_APM_STRICT=true` and the live skills CLI suite with `TEST_SKILLS_STRICT=true`, then runs the APM suite again with `TEST_APM_RECORD=true` and uploads `test/fixtures/apm/` as the `apm-recording-<os>` artifact, so every run produces a Linux and a Windows recording to download, review and commit. A failure in the first run means APM changed its lock file, events or deployment (or apl broke). The fix is a new recording plus a reviewed code change, not a skip.

Ubuntu and Windows only, as in `main.yml`.

## Recordings

A recording is a **change detector, not a correctness oracle**: it says what APM wrote when it was recorded. Layout:

```
test/fixtures/apm/<apm-version>/<os>/      os is linux, macos or windows
  provenance.json                          APM version and commit, OS, date, commands, hash of the test plugins
  events.json                              the lifecycle events APM fired in each step, in order
  steps/<step>/
    apm.lock.yaml                          the lock after the step
    deployed.json                          files under the scope root after the step (relative, POSIX)
```

One recording per system, for the newest recorded APM release: when a newer release is recorded, the older recordings are deleted. `apl` no longer reads APM's event, so only the event names are kept; they are the evidence that `post-install` fires on every update that fires `post-update`.

Absolute paths are stored as `<HOME>` (the recorded home), `<PLUGINS>` (the copy of `test/fixtures/plugins`) and `<OUTSIDE>` (a folder outside the home, where the `claudedir-outside-install` step moves `CLAUDE_CONFIG_DIR`) and relocated into the test's own `.tmp/` account when replayed. User-scope steps are relative to the home; `project-*` steps to the project at `<HOME>/project`.

The test plugins: `test/fixtures/plugins/lifecycle-demo` is an Agent Plugins v1 plugin with `apl.json` at its root and in its skill `greet`; `lifecycle-demo-dep` is a Claude Code format plugin (`.claude-plugin/plugin.json`) with `apl.json` in its skill `shout`. Each script writes a marker file in its copy.

| Steps | Scope | Source |
| --- | --- | --- |
| `install`, `update`, `reinstall`, `uninstall` | user (`-g`) | the two test plugins from local paths; "reinstall" changes `lifecycle-demo`, so only its copies run again |
| `project-install`, `project-update`, `project-reinstall`, `project-uninstall` | project | the same, in a project |
| `git-*` | user | `anthropics/claude-plugins-official`, `plugins/commit-commands`: a plugin in a subfolder, no release tags; the update edits the pin to a second fixed commit and runs `apm install -g --update` |
| `gitroot-*` | user | `obra/superpowers` at the commit of tag `v7.0.0`: a plugin at the repository root, `--target claude`; `apm update -g --yes` |
| `gitskills-*` | user | `vercel-labs/skills` at the commit of tag `v1.2.0`, `skills: [find-skills]`: a plain skills repository; `apm update -g --yes` |

The public repositories ship no `apl.json`, so the Git scenarios add one to each copy APM deployed (`GIT_MANIFEST` in `test/lib/apm-live.ts`); nothing of those repositories runs. For the two tagged sources APM moves a full-SHA pin to the latest release, so those scenarios assert only what holds for any newer release. When a pinned commit is not reachable the scenario skips with that reason (fails under `TEST_APM_STRICT=true`). Pins are constants in `test/lib/apm-live.ts`; `provenance.json` records what each recording used.

The replay checks `plugin_fixtures_sha256` for every recording, so a change to `test/fixtures/plugins` needs new recordings. 0.39.1 is recorded on Linux (Docker, below) and on Windows (the `APM` workflow's `apm-recording-windows-latest` artifact of run 45995655731). A Windows recording can only come from a GitHub runner.

### Record on Linux in Docker (disposable)

Docker is not part of the suite and nothing depends on it. It is how the Linux recording is made without installing APM on a developer machine: a public Node image, the package copied in from a read-only mount, no home directory, credentials or SSH keys.

```sh
docker run --name apl-record -v "$PWD":/pkg:ro node:22-bookworm bash -c '
  set -eu
  mkdir -p /work/pkg && tar -C /pkg --exclude=./node_modules --exclude=./.tmp --exclude=./.git --exclude=./.agents --exclude=./dist -cf - . | tar -C /work/pkg -xf -
  cd /work/pkg && npm ci && npm run build
  curl -fsSL https://aka.ms/apm-unix | sh -s -- --prefix /usr/local @v0.39.1
  TEST_APM_STRICT=true TEST_APM_VERSION=0.39.1 TEST_APM_RECORD=true \
    TEST_APM_RECORD_ENVIRONMENT="docker node:22-bookworm" \
    npm run test:apm'
docker cp apl-record:/work/pkg/test/fixtures/apm ./test/fixtures/apm
docker rm apl-record
```

Copy the package in this way, not with a macOS `tar` piped into the container: that adds AppleDouble `._*` files, and APM fails on them inside a plugin ("'utf-8' codec can't decode"). Review `git diff` of the fixtures before committing. For troubleshooting, the same container runs the live suite without `TEST_APM_RECORD`.
