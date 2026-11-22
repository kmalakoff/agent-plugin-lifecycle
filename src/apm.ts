import { readFile } from 'node:fs/promises';
import { basename, posix, win32 } from 'node:path';
import { parse } from 'yaml';

export interface LockedPlugin {
  host: string;
  repo: string;
  path: string;
  revision: string;
  localPath?: string;
  nativePluginRoot?: string;
  deployedFiles: string[];
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
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
export function sourceParts(source: string): { host: string; repo: string } | undefined {
  let host: string;
  let path: string;
  const scp = source.includes('://') ? null : /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(source);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const url = new URL(source);
      if (!['https:', 'ssh:', 'http:'].includes(url.protocol)) return undefined;
      host = url.hostname;
      path = url.pathname.replace(/^\//, '');
    } catch {
      return undefined;
    }
  }
  path = path.replace(/\.git$/, '').replace(/\/$/, '');
  if (!host || !path || path.split('/').some((part) => !part || part === '.' || part === '..')) return undefined;
  return { host: host.toLowerCase(), repo: path };
}
// Same path whatever separators or trailing slash either side was written with; Windows paths also ignore case.
export function samePath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return posix.resolve(left) === posix.resolve(right);
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
}
export function matchesSource(policySource: string, plugin: LockedPlugin, platform: NodeJS.Platform = process.platform): boolean {
  if (plugin.localPath !== undefined) return samePath(policySource, plugin.localPath, platform);
  const parts = sourceParts(policySource);
  return !!parts && parts.host === plugin.host.toLowerCase() && parts.repo === plugin.repo.replace(/\.git$/, '');
}
export function localEventName(source: string): string {
  return `_local/${basename(source).replace(/\/$/, '')}`;
}
export function lockIdentity(plugin: LockedPlugin): string {
  return JSON.stringify([plugin.host, plugin.repo, plugin.path, plugin.localPath ?? null]);
}
export function parseLock(value: unknown): LockedPlugin[] {
  const root = record(value, 'APM lock');
  if (!Array.isArray(root.dependencies)) throw new Error('APM lock dependencies must be an array');
  const seen = new Set<string>();
  return root.dependencies.map((raw, index): LockedPlugin => {
    const label = `APM lock dependencies[${index}]`;
    const source = record(raw, label);
    let plugin: LockedPlugin;
    if (source.source === 'local' && source.package_type === 'agent_plugin') {
      const repo = safePath(source.repo_url, `${label}.repo_url`);
      if (!repo.startsWith('_local/')) throw new Error(`${label}.repo_url is not a local plugin key`);
      const localPath = requiredString(source.local_path, `${label}.local_path`);
      const hash = requiredString(source.content_hash, `${label}.content_hash`);
      if (!/^sha256:[0-9a-f]{64}$/.test(hash)) throw new Error(`${label} has invalid content hash`);
      plugin = { host: 'local', repo, path: '.', revision: hash, localPath, deployedFiles: [] };
    } else {
      const host = requiredString(source.host, `${label}.host`);
      const repo = safePath(source.repo_url, `${label}.repo_url`);
      // APM writes no virtual_path for a plugin at the repository root (recorded from APM 0.37.0)
      const path = source.virtual_path === undefined || source.virtual_path === null ? '.' : safePath(source.virtual_path, `${label}.virtual_path`, true);
      const commit = requiredString(source.resolved_commit, `${label}.resolved_commit`);
      const hash = requiredString(source.content_hash, `${label}.content_hash`);
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) || !/^sha256:[0-9a-f]{64}$/.test(hash)) throw new Error(`${label} has invalid revision evidence`);
      const native = source.native_plugin === undefined || source.native_plugin === null ? undefined : record(source.native_plugin, `${label}.native_plugin`);
      const nativePluginRoot = native ? safePath(native.root, `${label}.native_plugin.root`) : undefined;
      const deployed = source.deployed_files ?? [];
      if (!Array.isArray(deployed) || !deployed.every((file) => typeof file === 'string')) throw new Error(`${label}.deployed_files must be an array of paths`);
      const deployedFiles = deployed.map((file: string, fileIndex: number) => safePath(file, `${label}.deployed_files[${fileIndex}]`));
      plugin = { host, repo, path, revision: `${commit}:${hash}`, nativePluginRoot, deployedFiles };
    }
    const identity = lockIdentity(plugin);
    if (seen.has(identity)) throw new Error(`${label} duplicates another lock entry`);
    seen.add(identity);
    return plugin;
  });
}
export async function loadLock(path: string): Promise<LockedPlugin[]> {
  return parseLock(parse(await readFile(path, 'utf8')));
}
