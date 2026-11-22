import { readFile } from 'node:fs/promises';

export type Platform = 'darwin' | 'linux' | 'win32';
export interface PluginPolicy {
  source: string;
  path?: string;
  skill?: string;
  'post-install'?: string;
  'post-update'?: string;
  'post-uninstall'?: string;
}
export interface Config {
  version: 1;
  plugins: PluginPolicy[];
}

function object(value: unknown, label: string, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} has unknown field: ${unknown}`);
  return result;
}
function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}
function relativePath(value: unknown, label: string): string {
  const path = nonempty(value, label);
  if (path === '.') return path;
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} must be a safe relative POSIX path`);
  }
  return path;
}
export function recordId(plugin: PluginPolicy): string {
  return JSON.stringify([plugin.source, plugin.path ?? '.', plugin.skill ?? null]);
}
export function parseConfig(value: unknown): Config {
  const root = object(value, 'config', ['version', 'plugins']);
  if (root.version !== 1 || !Array.isArray(root.plugins)) throw new Error('config must have version 1 and a plugins array');
  const seen = new Set<string>();
  const plugins = root.plugins.map((raw, index): PluginPolicy => {
    const label = `plugins[${index}]`;
    const item = object(raw, label, ['source', 'path', 'skill', 'post-install', 'post-update', 'post-uninstall']);
    const source = nonempty(item.source, `${label}.source`);
    const path = item.path === undefined ? undefined : relativePath(item.path, `${label}.path`);
    const skill = item.skill === undefined ? undefined : nonempty(item.skill, `${label}.skill`);
    if (skill && (skill.includes('/') || skill.includes('\\') || skill === '.' || skill === '..')) throw new Error(`${label}.skill must be one directory name`);
    const plugin: PluginPolicy = { source, path, skill };
    for (const event of ['post-install', 'post-update', 'post-uninstall'] as const) {
      if (item[event] !== undefined) plugin[event] = nonempty(item[event], `${label}.${event}`);
    }
    const id = recordId(plugin);
    if (seen.has(id)) throw new Error(`${label} duplicates another source/path/skill record`);
    seen.add(id);
    return plugin;
  });
  return { version: 1, plugins };
}
export async function loadConfig(path: string): Promise<Config> {
  return parseConfig(JSON.parse(await readFile(path, 'utf8')));
}
