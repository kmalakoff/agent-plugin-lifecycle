import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { APM_LOCK, APM_MODULES, SKILLS } from './constants.ts';
import { message, missing } from './lib/errors.ts';
import { isRecord } from './lib/object.ts';

/**
 * One `dependencies` row of APM's `apm.lock.yaml`. Paths are relative POSIX paths, checked to stay inside their root; a user-scope lock may
 * also record absolute deployed paths (a harness folder moved outside the home, as with `CLAUDE_CONFIG_DIR`).
 */
export interface LockedPackage {
  /** `<host>` or `<host>:<port>`; absent for a local path and for a row that records none. */
  host?: string;
  /** `owner/repo` for Git, `_local/<folder>` for a local path; with `path`, APM's cache copy under `apm_modules`. */
  repo: string;
  /** The plugin's folder inside the repository, `.` for the root. */
  path: string;
  /** The local source path exactly as APM wrote it. */
  localPath?: string;
  /** Whichever of `resolved_commit`, `resolved_hash` and `content_hash` the row has, joined by `:`. */
  revision: string;
  nativePluginRoot?: string;
  deployedFiles: string[];
  deployedFileHashes?: Record<string, string>;
  skillSubset?: string[];
}
/** A row `apl` cannot use, named by its `repo_url` (or its place in the lock); its recorded paths passed the path checks. */
export interface UnreadableRow {
  name: string;
  reason: string;
  nativePluginRoot?: string;
  deployedFiles: string[];
}
export type LockRow = LockedPackage | UnreadableRow;
export const isUnreadable = (row: LockRow): row is UnreadableRow => 'reason' in row;
/** Where one APM scope keeps its lock and deploys its copies. */
export interface Scope {
  global: boolean;
  lock: string;
  /** The folder deployed paths in the lock are relative to: the project, or the home. */
  root: string;
  /** The folder holding `apm.yml`; relative local paths are relative to it. */
  manifestRoot: string;
  /** APM's cache of each package (`apm_modules`), where scripts never run. */
  modules: string;
}
/** A folder the lock names for a package, and where it sits inside the package (`''` or `skills/<name>`). */
export interface PackageFolder {
  folder: string;
  within: string;
  /** The folder its real path must stay inside: the scope root for a relative path; none for an absolute path in a user-scope lock. */
  bound?: string;
  /** Per-copy content revision derived from `deployed_file_hashes`; absent to fall back to the row revision. */
  revision?: string;
}
/** The copies the lock records for a package, and each folder of APM's cache of it whose place in the package no recorded folder carries. */
export interface PackageFolders {
  folders: PackageFolder[];
  cache: PackageFolder[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a nonempty string`);
  return value;
}
function safePath(value: unknown, label: string, dot = false): string {
  const path = requiredString(value, label);
  if (dot && path === '.') return path;
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`${label} contains an unsafe path segment`);
  return path;
}
function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  return value === undefined || value === null ? undefined : record(value, label);
}
function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined || value === null ? undefined : requiredString(value, label);
}
function optionalStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' || !entry) return undefined;
    out[key] = entry;
  }
  return out;
}
function optionalStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) return undefined;
  return value;
}
function deployedFiles(value: unknown, label: string, absolute: boolean): string[] {
  const deployed = value ?? [];
  if (!Array.isArray(deployed) || !deployed.every((file) => typeof file === 'string')) throw new Error(`${label}.deployed_files must be an array of paths`);
  return deployed.map((file: string, index: number) => (absolute && isAbsolute(file) ? file : safePath(file, `${label}.deployed_files[${index}]`)));
}
/**
 * `repo_url` as a path, and the host when it is a URL (APM's spec: `host` is recorded "when not inferable from `repo_url`"). An unsafe
 * path throws, for the whole lock; a value that names no path (empty, or a URL that does not parse) is `undefined`, for its row alone.
 */
function repository(value: string, label: string): { host?: string; repo: string } | undefined {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value ? { repo: safePath(value, label) } : undefined;
  const url = URL.parse(value);
  const path = url?.pathname.slice(1);
  return url && path ? { host: url.host, repo: safePath(path, label) } : undefined;
}

/**
 * The rows of a parsed lock. A path that could leave its root makes the whole lock unreadable; any other problem makes only its row
 * unreadable. `absolute` accepts absolute deployed paths, which only a user-scope lock may hold.
 */
export function parseLock(value: unknown, absolute = false): LockRow[] {
  const root = record(value, 'APM lock');
  if (!Array.isArray(root.dependencies)) throw new Error('APM lock dependencies must be an array');
  const seen = new Set<string>();
  return root.dependencies.map((source, index): LockRow => {
    const label = `APM lock dependencies[${index}]`;
    if (!isRecord(source)) return { name: `dependencies[${index}]`, reason: `${label} must be an object`, deployedFiles: [] };
    const local = source.source === 'local';
    // the paths: where apl looks for copies, and APM's cache of the package
    const native = optionalRecord(source.native_plugin, `${label}.native_plugin`);
    const nativePluginRoot = native ? safePath(native.root, `${label}.native_plugin.root`) : undefined;
    const deployed = deployedFiles(source.deployed_files, label, absolute);
    const located = typeof source.repo_url === 'string' ? repository(source.repo_url, `${label}.repo_url`) : undefined;
    // APM writes no virtual_path for a plugin at the repository root
    const path = local || source.virtual_path === undefined || source.virtual_path === null ? '.' : safePath(source.virtual_path, `${label}.virtual_path`, true);
    try {
      if (!located) throw new Error(`${label}.repo_url must be a repository path or URL`);
      const revision = [optionalString(source.resolved_commit, `${label}.resolved_commit`), optionalString(source.resolved_hash, `${label}.resolved_hash`), optionalString(source.content_hash, `${label}.content_hash`)].filter(Boolean).join(':');
      if (!revision) throw new Error(`${label} has none of resolved_commit, resolved_hash and content_hash`);
      const deployedFileHashes = optionalStringMap(source.deployed_file_hashes);
      const skillSubset = optionalStringList(source.skill_subset);
      const extras = {
        ...(deployedFileHashes === undefined ? {} : { deployedFileHashes }),
        ...(skillSubset === undefined ? {} : { skillSubset }),
      };
      let item: LockedPackage;
      if (local) {
        if (!located.repo.startsWith('_local/')) throw new Error(`${label}.repo_url is not a local package key`);
        item = { repo: located.repo, path, localPath: requiredString(source.local_path, `${label}.local_path`), revision, nativePluginRoot, deployedFiles: deployed, ...extras };
      } else {
        const host = optionalString(source.host, `${label}.host`) ?? located.host;
        if (source.port !== undefined && source.port !== null && !Number.isInteger(source.port)) throw new Error(`${label}.port must be an integer`);
        const port = host === undefined || source.port === undefined || source.port === null ? '' : `:${source.port}`;
        item = { ...(host === undefined ? {} : { host: `${host}${port}` }), repo: located.repo, path, revision, nativePluginRoot, deployedFiles: deployed, ...extras };
      }
      const identity = JSON.stringify([item.host ?? null, item.repo, item.path, item.localPath ?? null]);
      if (seen.has(identity)) throw new Error(`${label} duplicates another lock entry`);
      seen.add(identity);
      return item;
    } catch (error) {
      return { name: typeof source.repo_url === 'string' && source.repo_url ? source.repo_url : `dependencies[${index}]`, reason: message(error), nativePluginRoot, deployedFiles: deployed };
    }
  });
}

/** The rows of an APM lock file, or undefined when the file does not exist. `absolute` as for `parseLock`. */
export async function readLock(path: string, absolute = false): Promise<LockRow[] | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  try {
    // no pretty errors: the message quotes none of the file
    return parseLock(parse(text, { prettyErrors: false }), absolute);
  } catch (error) {
    throw new Error(`cannot read ${path}: ${message(error)}`);
  }
}

async function samePlace(left: string, right: string): Promise<boolean> {
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
/** The user scope with `global`, or when `cwd` is the APM home (where APM starts a user-scope lifecycle command); otherwise the project in `cwd`. */
export async function resolveScope(options: { global: boolean; cwd: string; home: string; apmHome: string }): Promise<Scope> {
  const { cwd, home, apmHome } = options;
  if (options.global || (await samePlace(cwd, apmHome))) return { global: true, lock: join(apmHome, APM_LOCK), root: home, manifestRoot: apmHome, modules: join(apmHome, APM_MODULES) };
  return { global: false, lock: join(cwd, APM_LOCK), root: cwd, manifestRoot: cwd, modules: join(cwd, APM_MODULES) };
}

const native = (path: string) => join(...path.split('/'));
async function skillFolders(folder: string, bound?: string): Promise<PackageFolder[]> {
  try {
    const entries = await readdir(join(folder, SKILLS), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .map((name) => ({ folder: join(folder, SKILLS, name), within: `${SKILLS}/${name}`, ...(bound === undefined ? {} : { bound }) }));
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}
/** A folder and its `skills/<name>/` folders. */
async function withSkills(folder: string, bound?: string): Promise<PackageFolder[]> {
  return [{ folder, within: '', ...(bound === undefined ? {} : { bound }) }, ...(await skillFolders(folder, bound))];
}
/** `entry` is a folder in APM's record: another recorded path lies under it. */
function recordedFolder(entry: string, entries: string[]): boolean {
  return entries.some((other) => other.length > entry.length && other.startsWith(entry) && (other[entry.length] === '/' || other[entry.length] === '\\'));
}
/** SHA-256 digest of the sorted `(relativePath, hash)` pairs APM recorded under `entry`, or undefined when none were recorded. */
function copyContentRevision(entry: string, hashes: Record<string, string> | undefined): string | undefined {
  if (!hashes) return undefined;
  const pairs: [string, string][] = [];
  for (const [file, digest] of Object.entries(hashes)) {
    if (file.length > entry.length && file.startsWith(entry) && (file[entry.length] === '/' || file[entry.length] === '\\')) {
      pairs.push([file.slice(entry.length + 1).replace(/\\/g, '/'), digest]);
    }
  }
  if (!pairs.length) return undefined;
  pairs.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const hash = createHash('sha256');
  for (const [rel, digest] of pairs) hash.update(rel).update('\0').update(digest).update('\0');
  return `sha256:${hash.digest('hex')}`;
}
/** The folders a row records: each folder in `deployed_files` (a skill folder, at `skills/<its name>`), and the native plugin folder with its skills. */
export async function recordedFolders(item: Pick<LockedPackage, 'deployedFiles' | 'nativePluginRoot' | 'deployedFileHashes'>, scope: Scope): Promise<PackageFolder[]> {
  const folders: PackageFolder[] = [];
  const seen = new Set<string>();
  for (const entry of item.deployedFiles) {
    if (!recordedFolder(entry, item.deployedFiles)) continue;
    const absolute = isAbsolute(entry);
    // an absolute path in the platform's own form: APM on Windows records `D:/...` with forward slashes
    const folder = absolute ? resolve(entry) : join(scope.root, native(entry));
    if (seen.has(folder)) continue;
    seen.add(folder);
    const revision = copyContentRevision(entry, item.deployedFileHashes);
    folders.push({
      folder,
      within: `${SKILLS}/${basename(folder)}`,
      ...(absolute ? {} : { bound: scope.root }),
      ...(revision === undefined ? {} : { revision }),
    });
  }
  if (item.nativePluginRoot) for (const found of await withSkills(join(scope.root, native(item.nativePluginRoot)), scope.root)) if (!seen.has(found.folder)) folders.push(found);
  return folders;
}
/** The folders a package's row records, and the root and skills of its APM cache copy whose place in the package no recorded folder carries. */
export async function packageFolders(item: LockedPackage, scope: Scope): Promise<PackageFolders> {
  const folders = await recordedFolders(item, scope);
  const carried = new Set(folders.map((found) => found.within));
  const selected = item.skillSubset?.length ? new Set(item.skillSubset) : undefined;
  // the cache is never read or run, so it has no bound; unselected skills in a skill_subset are not reported skipped
  const cache = (await withSkills(join(scope.modules, native(item.repo), ...(item.path === '.' ? [] : [native(item.path)])))).filter((found) => {
    if (carried.has(found.within)) return false;
    if (selected && found.within.startsWith(`${SKILLS}/`)) return selected.has(found.within.slice(SKILLS.length + 1));
    return true;
  });
  return { folders, cache };
}
