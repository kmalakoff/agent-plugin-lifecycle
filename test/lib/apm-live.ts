import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { join, parse as parsePath, relative, sep } from 'node:path';
import { safeRmSync } from 'fs-remove-compat';
import { parse as parseYaml } from 'yaml';

/** Plugin names under test/fixtures/plugins/. */
export const PLUGIN = 'lifecycle-demo';
export const DEPENDENCY = 'lifecycle-demo-dep';

export const packageRoot = process.cwd();
export const pluginFixtures = join(packageRoot, 'test', 'fixtures', 'plugins');
export const recordingsRoot = join(packageRoot, 'test', 'fixtures', 'apm');

export type OsLabel = 'linux' | 'macos' | 'windows';
export function osLabel(platform: NodeJS.Platform = process.platform): OsLabel {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

export const STEPS = ['install', 'update', 'reinstall', 'uninstall'] as const;
export type Step = (typeof STEPS)[number];
/** The Git-sourced scenario's steps: the same plugin installed from a real HTTPS Git host, moved to a second commit, then removed. */
export const GIT_STEPS = ['git-install', 'git-update', 'git-uninstall'] as const;
export type GitStep = (typeof GIT_STEPS)[number];
/** The whole-repository Git scenario: the plugin sits at the repository root (`path: .`). */
export const GIT_ROOT_STEPS = ['gitroot-install', 'gitroot-update', 'gitroot-uninstall'] as const;
export type GitRootStep = (typeof GIT_ROOT_STEPS)[number];
export type AnyStep = Step | GitStep | GitRootStep;

/**
 * The real HTTPS Git host for the Git-sourced scenario is this public repository, but not its `master` (that history is squashed
 * before publishing, which would drop pinned commits): the plugin lives on the orphan branch `apm-test-plugin`, which holds only
 * `lifecycle-demo/` in exactly two commits and must never be rewritten or deleted. The scenario installs the plugin from that
 * folder at `first`, then edits the pin in `apm.yml` to `second` and runs `apm update` (APM moves a full-SHA pin only when the
 * manifest changes). The two commits differ in a `Content version: N` line in `skills/greet/SKILL.md`.
 */
export interface GitSource {
  url: string;
  host: string;
  repo: string;
  branch: string;
  path: string;
  pins: { first: { sha: string; content: string }; second: { sha: string; content: string } };
}
export const GIT_SOURCE: GitSource = {
  url: 'https://github.com/kmalakoff/agent-plugin-lifecycle',
  host: 'github.com',
  repo: 'kmalakoff/agent-plugin-lifecycle',
  branch: 'apm-test-plugin',
  path: 'lifecycle-demo',
  pins: {
    first: { sha: '440b061092fe164a82750e901fc49bcd77c858e6', content: 'Content version: 1' },
    second: { sha: 'bbf4b3c35e32cb68711e44df0f9f430da314d130', content: 'Content version: 2' },
  },
};

/** The same plugin at the repository root, on the orphan branch `apm-test-plugin-root` (two commits, same rules as above). */
export const GIT_ROOT_SOURCE: GitSource = {
  url: 'https://github.com/kmalakoff/agent-plugin-lifecycle',
  host: 'github.com',
  repo: 'kmalakoff/agent-plugin-lifecycle',
  branch: 'apm-test-plugin-root',
  path: '.',
  pins: {
    first: { sha: 'b4d602c158f866a09e1068befdcb197b68b47320', content: 'Content version: 1' },
    second: { sha: 'a6829cf567d46b158d19edcaa0c1e82aaced3904', content: 'Content version: 2' },
  },
};

/**
 * Every home, config and temp location APM (and the harnesses it writes for) honours, all pointed inside one disposable home.
 * Only variables the runner and APM need are passed through from the real environment (PATH and the Windows system variables).
 */
export function isolatedEnvironment(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const temp = join(home, '.tmp');
  const { root } = parsePath(home);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? process.env.Path,
    SystemRoot: process.env.SystemRoot,
    SYSTEMROOT: process.env.SYSTEMROOT,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    WINDIR: process.env.WINDIR,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: process.platform === 'win32' ? root.replace(/[\\/]$/, '') : undefined,
    HOMEPATH: process.platform === 'win32' ? home.slice(root.length - 1) : undefined,
    APM_HOME: join(home, '.apm'),
    APM_CACHE_DIR: join(home, '.cache', 'apm'),
    APM_TEMP_DIR: temp,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    COPILOT_HOME: join(home, '.copilot'),
    CODEX_HOME: join(home, '.codex'),
    HERMES_HOME: join(home, '.hermes'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    SHELL: '/bin/sh',
    ...extra,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

/** A fresh disposable account under the package .tmp/: <root>/home (the account home) and <root>/plugins (a copy of the test plugins). */
export async function makeAccount(prefix: string): Promise<{ root: string; home: string; plugins: string }> {
  const scratch = join(packageRoot, '.tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, `${prefix}-`));
  const home = join(root, 'home');
  const plugins = join(root, 'plugins');
  await mkdir(join(home, '.tmp'), { recursive: true });
  await cp(pluginFixtures, plugins, { recursive: true });
  return { root, home, plugins };
}
export function removeAccount(root: string): void {
  safeRmSync(root);
}

/** The runner's policy for the test plugin and its dependency; the commands leave marker files in the folders the runner chose. */
export function lifecycleConfig(plugins: string): { version: 1; plugins: Record<string, string>[] } {
  const write = (file: string, value: string) => `node -e "require('fs').writeFileSync('${file}',${value})"`;
  return {
    version: 1,
    plugins: [
      { source: join(plugins, PLUGIN), 'post-install': write('installed.marker', "'yes'"), 'post-uninstall': write('cleanup.done', "'ok'") },
      { source: join(plugins, PLUGIN), skill: 'greet', 'post-install': write('setup.done', 'process.env.HOME') },
      { source: join(plugins, DEPENDENCY), skill: 'shout', 'post-install': write('setup.done', 'process.env.HOME') },
    ],
  };
}

/** The runner's policy for the Git-sourced test plugin: markers in the folders the runner chose, one set for the plugin folder and one for its skill. */
export function gitLifecycleConfig(source: { url: string; path: string } = GIT_SOURCE): { version: 1; plugins: Record<string, string>[] } {
  const write = (file: string, value: string) => `node -e "require('fs').writeFileSync('${file}',${value})"`;
  const where: Record<string, string> = source.path === '.' ? {} : { path: source.path };
  return {
    version: 1,
    plugins: [
      { source: source.url, ...where, 'post-install': write('installed.marker', "'yes'"), 'post-update': write('updated.marker', "'yes'"), 'post-uninstall': write('cleanup.done', "'ok'") },
      { source: source.url, ...where, skill: 'greet', 'post-install': write('setup.done', 'process.env.HOME'), 'post-update': write('setup.updated', 'process.env.HOME') },
    ],
  };
}

export function deepShape(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return [...new Set(value.map((item) => JSON.stringify(deepShape(item))))].sort().map((text) => JSON.parse(text));
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((key) => [key, deepShape((value as Record<string, unknown>)[key])])
    );
  return typeof value;
}

/** Absolute paths in recordings are stored as tokens so a recording can be relocated into any test home. */
export interface Locations {
  home: string;
  plugins: string;
}
const escapeJson = (text: string): string => JSON.stringify(text).slice(1, -1);
export function tokenize(text: string, locations: Locations, json: boolean): string {
  let result = text;
  for (const [token, path] of [
    ['<PLUGINS>', locations.plugins],
    ['<HOME>', locations.home],
  ] as const) {
    for (const form of new Set([path, escapeJson(path)])) result = result.split(form).join(token);
  }
  // keep recorded paths POSIX-shaped whatever OS wrote them
  return result.replace(/<(?:HOME|PLUGINS)>([\\/][^"'\s,\]}]*)/g, (match, rest: string) => match.slice(0, match.length - rest.length) + rest.replace(json ? /\\\\|\\/g : /\\/g, '/'));
}
export function relocate(text: string, locations: Locations, json: boolean): string {
  const place = (path: string) => (json ? escapeJson(path) : path);
  return text.split('<PLUGINS>').join(place(locations.plugins)).split('<HOME>').join(place(locations.home));
}
export interface RecordedStep {
  lock: string;
  events: { file: string; payload: string }[];
  deployed: string[];
}
export interface Recording {
  dir: string;
  version: string;
  os: string;
  provenance: Record<string, unknown>;
  steps: Record<Step, RecordedStep>;
  /** Present when the recording includes the Git-sourced scenario. */
  gitSteps?: Record<GitStep, RecordedStep>;
  /** Present when the recording includes the whole-repository Git scenario. */
  gitRootSteps?: Record<GitRootStep, RecordedStep>;
}
async function loadStep(dir: string, step: AnyStep): Promise<RecordedStep> {
  const base = join(dir, 'steps', step);
  const eventDir = join(base, 'events');
  const files = (await readdir(eventDir).catch(() => [])).sort();
  return {
    lock: await readFile(join(base, 'apm.lock.yaml'), 'utf8'),
    events: await Promise.all(files.map(async (file) => ({ file, payload: await readFile(join(eventDir, file), 'utf8') }))),
    deployed: JSON.parse(await readFile(join(base, 'deployed.json'), 'utf8')),
  };
}
/** Where a Git scenario of a recording installed from (its provenance), which can differ from the constants if the pins moved. */
export function recordedGitSource(recording: Recording, kind: 'git' | 'gitroot' = 'git'): { url: string; path: string; repo: string; host: string } {
  const source = recording.provenance[kind === 'git' ? 'git_source' : 'git_root_source'] as { url: string; path: string } | null | undefined;
  if (!source) throw new Error(`${recording.dir} has no ${kind === 'git' ? 'git_source' : 'git_root_source'} in provenance.json`);
  const parts = new URL(source.url).pathname.replace(/^\/|\.git$/g, '');
  return { url: source.url, path: source.path, repo: parts, host: new URL(source.url).hostname };
}
export async function loadRecording(dir: string): Promise<Recording> {
  const provenance = JSON.parse(await readFile(join(dir, 'provenance.json'), 'utf8'));
  const steps = {} as Record<Step, RecordedStep>;
  for (const step of STEPS) steps[step] = await loadStep(dir, step);
  let gitSteps: Record<GitStep, RecordedStep> | undefined;
  if (existsSync(join(dir, 'steps', GIT_STEPS[0]))) {
    gitSteps = {} as Record<GitStep, RecordedStep>;
    for (const step of GIT_STEPS) gitSteps[step] = await loadStep(dir, step);
  }
  let gitRootSteps: Record<GitRootStep, RecordedStep> | undefined;
  if (existsSync(join(dir, 'steps', GIT_ROOT_STEPS[0]))) {
    gitRootSteps = {} as Record<GitRootStep, RecordedStep>;
    for (const step of GIT_ROOT_STEPS) gitRootSteps[step] = await loadStep(dir, step);
  }
  const parts = relative(recordingsRoot, dir).split(sep);
  return { dir, version: parts[0], os: parts[1], provenance, steps, gitSteps, gitRootSteps };
}
export function listRecordings(): string[] {
  const dirs: string[] = [];
  const names = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
  for (const version of names(recordingsRoot).sort(compareVersions)) {
    for (const os of names(join(recordingsRoot, version)).sort()) {
      if (existsSync(join(recordingsRoot, version, os, 'provenance.json'))) dirs.push(join(recordingsRoot, version, os));
    }
  }
  return dirs;
}
export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index++) if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0);
  return 0;
}
/** The recording to compare a live run against: this OS at the run's version, else this OS at the newest version, else the newest recording. */
export async function pickRecording(version: string, os: OsLabel): Promise<string | undefined> {
  const all = listRecordings();
  const exact = all.find((dir) => dir === join(recordingsRoot, version, os));
  if (exact) return exact;
  const sameOs = all.filter((dir) => dir.endsWith(`${sep}${os}`));
  return sameOs[sameOs.length - 1] ?? all[all.length - 1];
}

/** Home-relative POSIX paths of every file under the home that APM (not the test's own commands) wrote. */
const IGNORED_PREFIXES = ['.tmp/', '.cache/', '.config/agent-plugin-lifecycle/', '.apm/logs/'];
const IGNORED_NAMES = new Set(['installed.marker', 'setup.done', 'cleanup.done']);
export async function listFiles(home: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(relative(home, full).split(sep).join('/'));
    }
  };
  await walk(home);
  return found.filter((path) => !IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix)) && !IGNORED_NAMES.has(path.split('/').pop() ?? '')).sort();
}

export async function hashTree(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (current: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else
        hash
          .update(`${relative(dir, full).split(sep).join('/')}\0`)
          .update((await readFile(full, 'utf8')).replace(/\r\n/g, '\n'))
          .update('\0');
    }
  };
  await walk(dir);
  return hash.digest('hex');
}
export function lockRows(text: string): Record<string, unknown>[] {
  const lock = parseYaml(text) as { dependencies?: Record<string, unknown>[] };
  return lock.dependencies ?? [];
}
