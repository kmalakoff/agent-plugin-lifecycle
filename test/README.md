# Tests

Two layers exercise one code path (`runLifecycle` and the built CLI). Which layer proves what:

| Layer | Files | Needs | Proves |
| --- | --- | --- | --- |
| Package tests | `test/unit`, `test/integration/reconcile.test.ts`, `test/integration/cli.test.ts` | Node only | Matching, receipts, cleanup and command execution against a fake account home under `.tmp/`. |
| Recorded replays | `test/integration/apm-recorded.test.ts` | Node only | The runner handles the lock files and event payloads of **real APM runs** saved in `test/fixtures/apm/<apm-version>/<os>/`, on every OS, every run. |
| Live APM | `test/integration/apm-live.test.ts` | `apm` on `PATH`; the Git scenario also needs the network | The installed `apm` installs, updates and uninstalls the test plugin (from a local path, and from this repository's public GitHub URL at two pinned commits), fires the events, the built CLI runs the configured commands in the folders APM deployed, and the lock/event shapes still match the recordings. |

Nothing here touches your real account. The live suite gives APM and the CLI a disposable home under `.tmp/` and sets `HOME`, `USERPROFILE`, `HOMEDRIVE`/`HOMEPATH`, `APM_HOME`, `APM_CACHE_DIR`, `APM_TEMP_DIR`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `CLAUDE_CONFIG_DIR`, `COPILOT_HOME`, `CODEX_HOME`, `HERMES_HOME`, `LOCALAPPDATA`, `APPDATA`, `TMPDIR`/`TMP`/`TEMP` and `GIT_CONFIG_GLOBAL` there (`test/lib/apm-live.ts`, `isolatedEnvironment`). Only `PATH` and the Windows system variables come from the real environment. Whether that keeps every APM write inside `.tmp/` on macOS and Windows has not been verified; the first `APM` workflow run will show it.

## Run locally

```sh
npm test                                   # everything; the live suite is skipped when apm is not on PATH
npx tsds test:node --no-timeouts test/integration/apm-recorded.test.ts   # one file
```

You never need APM to develop. If you do have it installed, the live suite runs on its own and still writes only under `.tmp/`.

| Setting | Effect |
| --- | --- |
| `TEST_APM_STRICT=true` | A missing `apm` fails the live suite instead of skipping it. The `APM` workflow (`.github/workflows/apm.yml`) sets it; that job is the environment that owns this coverage. |
| `TEST_APM_VERSION=x.y.z` | The `apm` on `PATH` must report exactly this version. No workflow sets it; the Docker recording below does (0.37.0, the recorded version). |
| `TEST_APM_RECORD=true` | The live run also writes `test/fixtures/apm/<apm-version>/<os>/` from what APM did. |

## CI

Both workflows run on push to `master` only.

- `main.yml` (`CI`): the house workflow, unchanged. It runs the package tests and the recorded replays; the live suite skips there because no `apm` is installed.
- `apm.yml` (`APM`): installs the **latest** APM release with its official installer (no pinned version), runs the live suite with `TEST_APM_STRICT=true`, then runs it again with `TEST_APM_RECORD=true` and uploads `test/fixtures/apm/` as the `apm-recording-<os>` artifact, so every run produces a Linux and a Windows recording to download, review and commit. There is no schedule: it runs when `master` is pushed. A failure in the first run means APM changed its lock file, events or deployment (or the runner broke). The fix is a new recording plus a reviewed code change, not a skip.

Ubuntu and Windows only, as in `main.yml`; macOS stays commented out there and here.

## Recordings

A recording is a **change detector, not a correctness oracle**: it says what APM wrote when it was recorded. Layout:

```
test/fixtures/apm/<apm-version>/<os>/      os is linux, macos or windows
  provenance.json                          APM version and commit, OS, date, commands, hash of the test plugins
  steps/<install|update|reinstall|uninstall>/
    apm.lock.yaml                          the user lock after the step
    deployed.json                          files under the home after the step (home-relative, POSIX)
    events/NNN-<event>.json                each lifecycle event payload APM sent
```

Absolute paths are stored as `<HOME>` (the recorded home) and `<PLUGINS>` (the copy of `test/fixtures/plugins`) and relocated into the test's own `.tmp/` home when replayed. `test/fixtures/plugins/lifecycle-demo` is a real Agent Plugins v1 plugin with one skill; `lifecycle-demo-dep` is the second small package APM installs beside it. APM 0.37.0 does not run `post-update` for local plugins, so the "update" step records that `apm update` changes nothing, and the "reinstall" step (plugin content changed, `apm install -g` again) is where a re-run is proven.
The Git-sourced scenario (`steps/git-install`, `git-update`, `git-uninstall`) installs `lifecycle-demo` from this repository's public HTTPS URL, subfolder `lifecycle-demo`, at a full commit SHA, then edits `apm.yml` to a second SHA and runs `apm update -g --yes` (APM moves a full-SHA pin only when the manifest changes; APM 0.37.0 then fires `post-install` and `post-update`). The two commits live on the orphan branch `apm-test-plugin`, which holds only the plugin in exactly two commits and must stay on GitHub, never rewritten and kept out of any `master` squash. A second scenario (`steps/gitroot-*`) installs the same plugin from the repository **root** (`path: .`, no `path:` in `apm.yml`) from the orphan branch `apm-test-plugin-root` (plugin.json and skills at its root, two commits). The pins are the constants `GIT_SOURCE` and `GIT_ROOT_SOURCE` in `test/lib/apm-live.ts`; when a pinned commit is not reachable the scenario skips with that reason (fails under `TEST_APM_STRICT=true`). `provenance.json` records the source and pins each recording used. `reconcile.test.ts` keeps hand-written Git rows only where no real APM output exists (several rows, `native_plugin`, `deployed_files`, a non-GitHub SCP source).

Linux (in Docker, below) and macOS (a local run) are recorded, Git scenario included. A Windows recording can only come from a GitHub runner: the `APM` workflow uploads it as an artifact. Until it is committed the replay uses the Linux recording on Windows.

### Record on Linux in Docker (disposable)

Docker is not part of the suite and nothing depends on it. It is how the Linux recording was made without installing APM on a developer machine: a public Node image, the package copied in from a read-only mount, no home directory, credentials or SSH keys.

```sh
docker run --name apl-record -v "$PWD":/pkg:ro node:22-bookworm bash -c '
  set -eu
  mkdir -p /work/pkg && tar -C /pkg --exclude=./node_modules --exclude=./.tmp --exclude=./.git --exclude=./.agents --exclude=./dist -cf - . | tar -C /work/pkg -xf -
  cd /work/pkg && npm ci && npm run build
  curl -fsSL https://aka.ms/apm-unix | sh -s -- --prefix /usr/local @v0.37.0
  TEST_APM_STRICT=true TEST_APM_VERSION=0.37.0 TEST_APM_RECORD=true \
    TEST_APM_RECORD_ENVIRONMENT="docker node:22-bookworm" \
    npm run test:apm'
docker cp apl-record:/work/pkg/test/fixtures/apm ./test/fixtures/apm
docker rm apl-record
```

Review `git diff` of the fixtures before committing. For troubleshooting, the same container runs the live suite without `TEST_APM_RECORD`.
