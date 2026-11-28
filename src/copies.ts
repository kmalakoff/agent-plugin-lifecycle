import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import isPathInside from 'is-path-inside';
import { isUnreadable, type LockedPackage, packageFolders, readLock, recordedFolders, resolveScope, type Scope } from './apm.ts';
import { CACHE_ONLY, INSTALL, MANIFEST, NO_PROJECT_LOCK } from './constants.ts';
import { message, missing } from './lib/errors.ts';
import { readManifest } from './manifest.ts';
import type { CopyResult } from './types.ts';

/** A folder holding an `apl.json`, the id a person approves, and, when found through APM, the revision APM locked. */
export interface Copy {
  id: string;
  folder: string;
  /** Where its approval is kept: the real path of the folder holding the lock (project or APM home), or of the named folder. */
  place: string;
  /** The command in `apl.json`; absent when `error` or `skipped` is set. */
  install?: string;
  /** Why the copy's `apl.json` cannot be used. */
  error?: string;
  /** Why the copy is not run and not counted against the exit code: APM's cache is its only copy. */
  skipped?: string;
  revision?: string;
  /** The APM lock file the copy was found through. */
  lock?: string;
}
export interface Found {
  copies: Copy[];
  /** Set when the copies came from an APM scope. */
  scope?: Scope;
  /** Every folder the scope's lock names, with or without an `apl.json`. */
  named: Set<string>;
}
export interface FindOptions {
  home: string;
  apmHome: string;
  cwd: string;
  global: boolean;
  folders?: string[];
}

/** `<host>/<repo>[/<path>]` for a Git package, the absolute source path for a local one. */
export function packageId(item: LockedPackage, manifestRoot: string): string {
  if (item.localPath !== undefined) return resolve(manifestRoot, item.localPath);
  return `${item.host === undefined ? '' : `${item.host}/`}${item.repo}${item.path === '.' ? '' : `/${item.path}`}`;
}
/** The package id, then `:<folder>` when `apl.json` sits below the package root. */
export function copyId(base: string, within: string): string {
  return within ? `${base}:${within}` : base;
}

/** `bound` when `real` is not inside its real path. */
async function outside(bound: string | undefined, real: string): Promise<string | undefined> {
  return bound !== undefined && !isPathInside(real, await realpath(bound)) ? bound : undefined;
}

/** The real path of `path`, or undefined when it does not exist. */
async function realOrMissing(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

/** `path` is `parent` or inside it. */
const under = (path: string, parent: string | undefined) => parent !== undefined && (path === parent || isPathInside(path, parent));

/**
 * The copy in a folder the lock names, if it holds an `apl.json`. A folder or `apl.json` that resolves into APM's cache (`cache`, a real
 * path) is skipped with `CACHE_ONLY`, and one that resolves outside `bound` is failed; neither is read or run.
 */
async function inspect(id: string, folder: string, bound: string | undefined, cache: string | undefined, place: string): Promise<Copy | undefined> {
  const real = await realOrMissing(folder);
  if (real === undefined) return undefined;
  if (under(real, cache)) return existsSync(join(real, MANIFEST)) ? { id, folder, place, skipped: CACHE_ONLY } : undefined;
  const left = await outside(bound, real);
  if (left !== undefined) return existsSync(join(real, MANIFEST)) ? { id, folder, place, error: `resolves to ${real}, outside ${left}` } : undefined;
  const file = await realOrMissing(join(folder, MANIFEST));
  if (file === undefined) return undefined;
  if (under(file, cache)) return { id, folder, place, skipped: CACHE_ONLY };
  const fileBound = await outside(bound, file);
  if (fileBound !== undefined) return { id, folder, place, error: `resolves to ${file}, outside ${fileBound}` };
  try {
    const install = await readManifest(folder);
    return install === undefined ? undefined : { id, folder, place, install };
  } catch (error) {
    if (missing(error)) return undefined;
    return { id, folder, place, error: message(error) };
  }
}

/** One copy per real path; a folder named must hold an `apl.json` with a `scripts.install`. */
async function namedCopies(cwd: string, folders: string[]): Promise<Copy[]> {
  const copies = new Map<string, Copy>();
  for (const argument of folders) {
    const path = resolve(cwd, argument);
    let folder: string;
    try {
      folder = await realpath(path);
    } catch (error) {
      if (!missing(error)) throw error;
      copies.set(path, { id: path, folder: path, place: path, error: `no ${MANIFEST}` });
      continue;
    }
    if (copies.has(folder)) continue;
    try {
      const install = await readManifest(folder);
      copies.set(folder, install === undefined ? { id: folder, folder, place: folder, error: `${MANIFEST} has no scripts.${INSTALL}` } : { id: folder, folder, place: folder, install });
    } catch (error) {
      copies.set(folder, { id: folder, folder, place: folder, error: missing(error) ? `no ${MANIFEST}` : message(error) });
    }
  }
  return [...copies.values()];
}

/** Copies of one id that carry different commands cannot share one approval: each is failed, and nothing is asked for them. */
function disagreeing(copies: Copy[]): Copy[] {
  const commands = new Map<string, Set<string>>();
  for (const { id, install } of copies) if (install !== undefined) commands.set(id, (commands.get(id) ?? new Set()).add(install));
  return copies.map((copy) => ((commands.get(copy.id)?.size ?? 0) > 1 ? { id: copy.id, folder: copy.folder, place: copy.place, error: `copies of ${copy.id} disagree on install`, revision: copy.revision, lock: copy.lock } : copy));
}

/** The copies of the named folders, or of every package in the scope's APM lock. */
export async function findCopies(options: FindOptions): Promise<Found> {
  const { home, apmHome, cwd, global, folders } = options;
  if (folders?.length) {
    if (global) throw new Error('-g cannot be combined with folders');
    return { copies: disagreeing(await namedCopies(cwd, folders)), named: new Set() };
  }
  const scope = await resolveScope({ global, cwd, home, apmHome });
  // a user-scope lock is the user's own file, written by APM, and may record absolute paths
  const packages = await readLock(scope.lock, scope.global);
  if (!packages && !scope.global) throw new Error(NO_PROJECT_LOCK);
  const copies: Copy[] = [];
  const named = new Set<string>();
  if (!packages) return { copies, scope, named };
  // the place of every copy in the scope: the real path of the folder holding the lock
  const place = await realpath(dirname(scope.lock));
  // nothing runs under APM's cache, whatever path or link leads there
  const cacheRoot = await realOrMissing(scope.modules);
  for (const item of packages) {
    if (isUnreadable(item)) {
      // its folders are still the lock's, so none of them is reported as left
      for (const { folder } of await recordedFolders(item, scope)) named.add(folder);
      copies.push({ id: item.name, folder: scope.lock, place, error: item.reason });
      continue;
    }
    const base = packageId(item, scope.manifestRoot);
    const { folders: recorded, cache } = await packageFolders(item, scope);
    for (const { folder, within, bound, revision } of recorded) {
      if (named.has(folder)) continue;
      named.add(folder);
      const copy = await inspect(copyId(base, within), folder, bound, cacheRoot, place);
      if (copy) copies.push({ ...copy, revision: revision ?? item.revision, lock: scope.lock });
    }
    for (const { folder, within } of cache) {
      if (named.has(folder)) continue;
      named.add(folder);
      // never read or run; reported, so an apl.json that reaches only APM's cache is not silently skipped
      if (existsSync(join(folder, MANIFEST))) copies.push({ id: copyId(base, within), folder, place, skipped: CACHE_ONLY, revision: item.revision, lock: scope.lock });
    }
  }
  return { copies: disagreeing(copies), scope, named };
}

/** The line for a copy with no command: `skipped` when APM's cache is its only copy, otherwise `failed`. */
export function cannotRun({ id, folder, error, skipped }: Copy): CopyResult {
  return skipped === undefined ? { status: 'failed', id, folder, reason: error } : { status: 'skipped', id, folder, reason: skipped };
}
