import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, parse as parsePath, relative, sep } from 'node:path';
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
/** The plain skill repository scenario: a repository of bare `skills/<name>/SKILL.md` folders with no manifest, one skill selected with `skills:`. */
export const GIT_SKILLS_STEPS = ['gitskills-install', 'gitskills-update', 'gitskills-uninstall'] as const;
export type GitSkillsStep = (typeof GIT_SKILLS_STEPS)[number];
/** The local plugins again, installed into a project (`apm install` without `-g`). */
export const PROJECT_STEPS = ['project-install', 'project-update', 'project-reinstall', 'project-uninstall'] as const;
export type ProjectStep = (typeof PROJECT_STEPS)[number];

/** GIT_SKILLS_SOURCE installed for Claude Code at user scope with CLAUDE_CONFIG_DIR outside the home folder, and inside it but not ~/.claude. */
export const CLAUDE_DIR_STEPS = ['claudedir-outside-install', 'claudedir-home-install'] as const;
export type ClaudeDirStep = (typeof CLAUDE_DIR_STEPS)[number];
export type AnyStep = Step | ProjectStep | GitStep | GitRootStep | GitSkillsStep | ClaudeDirStep;
export const ALL_STEPS: AnyStep[] = [...STEPS, ...PROJECT_STEPS, ...GIT_STEPS, ...GIT_ROOT_STEPS, ...GIT_SKILLS_STEPS, ...CLAUDE_DIR_STEPS];
/** The lifecycle events the live suite records; `apl install` is registered for `post-install` alone, as the README registers it. */
export const APM_EVENTS = ['post-install', 'post-update', 'post-uninstall'] as const;
export const APL_EVENT = 'post-install';

/**
 * The Git-sourced scenarios install real, popular public repositories the way a client does, never anything of ours.
 * `update: 'tag'` sources are pinned to the commit of an old annotated release tag; `apm update` moves a full-SHA pin to the
 * latest annotated semver tag, fires post-update, and so the scenario asserts only what holds for any newer release.
 * `update: 'pin'` is for a source without release tags: the test edits the pin to a second fixed commit and runs
 * `apm install --update` (post-install fires again). `skill` is the skill the scenario looks for; `select` is the `skills:`
 * selection written to apm.yml. The scripts are always the test's own `apl.json` (GIT_MANIFEST), never code from these repositories.
 */
export interface GitSource {
  url: string;
  host: string;
  repo: string;
  path: string;
  skill?: string;
  select?: string[];
  update: 'tag' | 'pin';
  /** The `--target` the scenario installs for; APM refuses obra/superpowers' hook files for the copilot target. */
  target: 'copilot' | 'claude';
  pins: { first: string; second?: string };
}
/** A plugin in a repository subfolder (`plugins/commit-commands`); the source has no release tags and no skills. */
export const GIT_SOURCE: GitSource = {
  url: 'https://github.com/anthropics/claude-plugins-official',
  host: 'github.com',
  repo: 'anthropics/claude-plugins-official',
  path: 'plugins/commit-commands',
  update: 'pin',
  target: 'copilot',
  pins: { first: '27d2b86d72da27c64585150857cee8472ad47abb', second: 'd5c15b861cd23e3102215c26020368ad5134dc47' },
};
/** A plugin at the repository root (obra/superpowers, annotated tag v7.0.0). */
export const GIT_ROOT_SOURCE: GitSource = {
  url: 'https://github.com/obra/superpowers',
  host: 'github.com',
  repo: 'obra/superpowers',
  path: '.',
  skill: 'using-superpowers',
  update: 'tag',
  target: 'claude',
  pins: { first: 'bb92a77741419a4ab5f06e711a283343f1ada0c3' },
};
/** A plain skill repository (bare `skills/<name>/SKILL.md`, no manifest; vercel-labs/skills, annotated tag v1.2.0), one skill selected with `skills:`. */
export const GIT_SKILLS_SOURCE: GitSource = {
  url: 'https://github.com/vercel-labs/skills',
  host: 'github.com',
  repo: 'vercel-labs/skills',
  path: '.',
  skill: 'find-skills',
  select: ['find-skills'],
  update: 'tag',
  target: 'copilot',
  pins: { first: 'cca706a50522ffade404618e23a2009f07c64828' },
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

/**
 * A fresh disposable account under the package .tmp/: <root>/home (the account home), <root>/plugins (a copy of the test plugins) and
 * <root>/outside (a folder outside the home, for harness folders moved there).
 */
export async function makeAccount(prefix: string): Promise<{ root: string; home: string; plugins: string; outside: string }> {
  const scratch = join(packageRoot, '.tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, `${prefix}-`));
  const home = join(root, 'home');
  const plugins = join(root, 'plugins');
  const outside = join(root, 'outside');
  await mkdir(join(home, '.tmp'), { recursive: true });
  await mkdir(outside);
  await cp(pluginFixtures, plugins, { recursive: true });
  return { root, home, plugins, outside };
}
export function removeAccount(root: string): void {
  safeRmSync(root);
}

/** The folder of the project-scope scenarios inside the account home. */
export const PROJECT = 'project';

/** The `apl.json` the Git scenarios add to each copy APM deployed (the public repositories ship none); the script creates `node_modules/ok` and `apl.marker`. */
export const GIT_MANIFEST = `${JSON.stringify({ scripts: { install: `node -e "const f=require('fs');f.mkdirSync('node_modules',{recursive:true});f.writeFileSync('node_modules/ok','yes');f.writeFileSync('apl.marker','yes')"` } })}\n`;

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
  /** A folder outside the home (`<OUTSIDE>`), for the CLAUDE_CONFIG_DIR steps. */
  outside?: string;
}
const escapeJson = (text: string): string => JSON.stringify(text).slice(1, -1);
export function tokenize(text: string, locations: Locations, json: boolean): string {
  let result = text;
  for (const [token, path] of [
    ['<PLUGINS>', locations.plugins],
    ['<OUTSIDE>', locations.outside],
    ['<HOME>', locations.home],
  ] as const) {
    if (path === undefined) continue;
    // APM on Windows writes some absolute paths with forward slashes (`D:/a/...`)
    for (const form of new Set([path, escapeJson(path), path.split('\\').join('/')])) result = result.split(form).join(token);
  }
  // keep recorded paths POSIX-shaped whatever OS wrote them
  return result.replace(/<(?:HOME|PLUGINS|OUTSIDE)>([\\/][^"'\s,\]}]*)/g, (match, rest: string) => match.slice(0, match.length - rest.length) + rest.replace(json ? /\\\\|\\/g : /\\/g, '/'));
}
export function relocate(text: string, locations: Locations, json: boolean): string {
  const place = (path: string) => (json ? escapeJson(path) : path);
  const relocated = text.split('<PLUGINS>').join(place(locations.plugins)).split('<HOME>').join(place(locations.home));
  return locations.outside === undefined ? relocated : relocated.split('<OUTSIDE>').join(place(locations.outside));
}
export interface RecordedStep {
  lock: string;
  /** The lifecycle events APM fired during the step, in order. */
  events: string[];
  deployed: string[];
}
export interface Recording {
  dir: string;
  version: string;
  os: string;
  provenance: Record<string, unknown>;
  /** Every step the recording holds; a Git scenario that could not run is absent. Project steps are relative to the project. */
  steps: Partial<Record<AnyStep, RecordedStep>>;
}
/** The recorded step, failing when the recording lacks it. */
export function recordedStep(recording: Recording, step: AnyStep): RecordedStep {
  const found = recording.steps[step];
  if (!found) throw new Error(`${recording.dir} has no ${step} step; record again (test/README.md)`);
  return found;
}
/** Where a Git scenario of a recording installed from (its provenance), which can differ from the constants if the pins moved. */
export function recordedGitSource(recording: Recording, kind: 'git' | 'gitroot' | 'gitskills' = 'git'): GitSource {
  const key = { git: 'git_source', gitroot: 'git_root_source', gitskills: 'git_skills_source' }[kind];
  const source = recording.provenance[key] as { url: string; path: string; skill?: string; select?: string[]; update: 'tag' | 'pin'; target: 'copilot' | 'claude'; first: string; second?: string } | null | undefined;
  if (!source) throw new Error(`${recording.dir} has no ${key} in provenance.json`);
  const parts = new URL(source.url).pathname.replace(/^\/|\.git$/g, '');
  return { url: source.url, path: source.path, skill: source.skill, select: source.select, update: source.update, target: source.target, repo: parts, host: new URL(source.url).hostname, pins: { first: source.first, second: source.second } };
}
/** The file of a recording that lists the events of each step. */
export const EVENTS_FILE = 'events.json';
export async function loadRecording(dir: string): Promise<Recording> {
  const provenance = JSON.parse(await readFile(join(dir, 'provenance.json'), 'utf8'));
  const events = JSON.parse(await readFile(join(dir, EVENTS_FILE), 'utf8')) as Record<string, string[]>;
  const steps: Partial<Record<AnyStep, RecordedStep>> = {};
  for (const step of ALL_STEPS) {
    const base = join(dir, 'steps', step);
    if (!existsSync(base)) continue;
    steps[step] = { lock: await readFile(join(base, 'apm.lock.yaml'), 'utf8'), events: events[step] ?? [], deployed: JSON.parse(await readFile(join(base, 'deployed.json'), 'utf8')) };
  }
  const parts = relative(recordingsRoot, dir).split(sep);
  return { dir, version: parts[0], os: parts[1], provenance, steps };
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
  // the lock and event shapes belong to the APM version, so the same version on another OS comes before an older version on this OS
  const sameVersion = all.filter((dir) => dir.startsWith(`${join(recordingsRoot, version)}${sep}`));
  if (sameVersion.length) return sameVersion[sameVersion.length - 1];
  const sameOs = all.filter((dir) => dir.endsWith(`${sep}${os}`));
  return sameOs[sameOs.length - 1] ?? all[all.length - 1];
}

/** Root-relative POSIX paths of every file under `root`, apart from scratch, caches, APM's logs, apl's own state and the project folder. */
const IGNORED_PREFIXES = ['.tmp/', '.cache/', '.apl/', '.apm/logs/', `${PROJECT}/`];
export async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(relative(root, full).split(sep).join('/'));
    }
  };
  await walk(root);
  return found.filter((path) => !IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix))).sort();
}

const KEPT_LOCAL = /^(?:\.apm\/)?apm_modules\/_local\/([^/]+)\/(.+)$/;
const NATIVE_FILE = /^\.agents\/plugins\/([^/.][^/]*)\/(.+)$/;
const SKILL_FILE = /^(?:\.agents|\.claude|\.hermes)\/skills\/([^/.][^/]*)\/(.+)$/;
/** The test plugin file a recorded deployed path is a copy of, or undefined when it is not one. */
async function fixtureSource(plugins: string, path: string): Promise<string | undefined> {
  const candidates: string[] = [];
  const kept = KEPT_LOCAL.exec(path) ?? NATIVE_FILE.exec(path);
  if (kept) candidates.push(join(plugins, kept[1], ...kept[2].split('/')));
  const skill = /(?:^|\/)skills\/([^/]+)\/(.+)$/.exec(path);
  if (skill) for (const plugin of [PLUGIN, DEPENDENCY]) candidates.push(join(plugins, plugin, 'skills', skill[1], ...skill[2].split('/')));
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return undefined;
}
/** Recreates a recorded step's files under `root` with the test plugins' content, and each kept local copy whole, as APM keeps it. */
export async function placeFiles(root: string, plugins: string, paths: string[]): Promise<void> {
  const keptPlugins = new Set<string>();
  for (const path of paths) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    const source = await fixtureSource(plugins, path);
    if (source) await cp(source, target);
    // the only other apl.json the live suite writes is the one the Git scenarios add, which APM may keep through an update
    else await writeFile(target, path.endsWith('apl.json') ? GIT_MANIFEST : '');
    const kept = KEPT_LOCAL.exec(path);
    if (kept) keptPlugins.add(path.slice(0, path.length - kept[2].length - 1));
  }
  for (const keptRoot of keptPlugins) {
    const name = keptRoot.split('/').pop() ?? '';
    for (const manifest of await manifestsIn(join(plugins, name))) {
      const target = join(root, ...keptRoot.split('/'), ...manifest.split('/'));
      await mkdir(dirname(target), { recursive: true });
      if (!existsSync(target)) await cp(join(plugins, name, ...manifest.split('/')), target);
    }
  }
}
/** Root-relative POSIX paths of every `apl.json` under `dir`. */
export async function manifestsIn(dir: string): Promise<string[]> {
  return (await listFiles(dir)).filter((path) => path === 'apl.json' || path.endsWith('/apl.json'));
}
const aplFolders = (files: string[]) => files.filter((path) => path === 'apl.json' || path.endsWith('/apl.json')).map((path) => path.split('/').slice(0, -1).join('/'));
const inCache = (folder: string) => /(^|\/)apm_modules\//.test(folder);
/** The folders apl must treat as copies, read from what APM deployed: every folder holding an `apl.json` outside APM's cache (`apm_modules`). */
export function expectedCopies(root: string, files: string[]): string[] {
  return aplFolders(files)
    .filter((folder) => !inCache(folder))
    .map((folder) => join(root, ...folder.split('/')))
    .sort();
}
/**
 * The folders a Git scenario adds `apl.json` to, read from what APM deployed: each deployed skill folder, and each native plugin folder
 * and its `skills/<name>/`. Empty when APM deployed neither, so its cache is the package's only copy.
 */
export function gitCopyFolders(root: string, files: string[]): string[] {
  const folders = new Set<string>();
  for (const path of files) {
    const parts = path.split('/');
    if (SKILL_FILE.test(path)) folders.add(parts.slice(0, 3).join('/'));
    if (NATIVE_FILE.test(path)) {
      folders.add(parts.slice(0, 3).join('/'));
      if (parts[3] === 'skills' && parts.length > 5) folders.add(parts.slice(0, 5).join('/'));
    }
  }
  return [...folders].map((folder) => join(root, ...folder.split('/'))).sort();
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

/** The recording of the newest APM version, for this OS when there is one. */
export async function newestRecording(): Promise<Recording> {
  const all = listRecordings();
  if (!all.length) throw new Error(`no recording under ${recordingsRoot}; record one (test/README.md)`);
  const versionOf = (dir: string) => relative(recordingsRoot, dir).split(sep)[0];
  const newest = all.filter((dir) => versionOf(dir) === versionOf(all[all.length - 1]));
  return loadRecording(newest.find((dir) => dir.endsWith(`${sep}${osLabel()}`)) ?? newest[newest.length - 1]);
}
/** Recreates a recorded step in `root` (its files and its lock at `lock`), relocated into `home` and `plugins`. */
export async function placeStep(step: RecordedStep, root: string, lock: string, locations: Locations, lockText: string = step.lock): Promise<void> {
  await placeFiles(root, locations.plugins, step.deployed);
  await mkdir(dirname(lock), { recursive: true });
  await writeFile(lock, relocate(lockText, locations, false));
}
