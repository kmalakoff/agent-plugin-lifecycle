import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import spawn from 'cross-spawn-cb';
import lockfile from 'proper-lockfile';
import { type LockedPlugin, loadLock, localEventName, matchesSource, samePath, sourceParts } from './apm.js';
import { loadConfig, type PluginPolicy, recordId } from './config.js';

export type Mode = 'run' | 'check';
export interface LifecycleEvent {
  schema_version: 1;
  event: 'post-install' | 'post-update' | 'post-uninstall';
  scope: 'user';
  packages: { name: string; reference: string | null }[];
}
interface State {
  version: 1;
  receipts: Record<string, string>;
}
export interface RunOptions {
  home?: string;
  apmHome?: string;
  configPath?: string;
  environment?: NodeJS.ProcessEnv;
  output?: (line: string) => void;
  event?: LifecycleEvent;
}
function inside(root: string, child: string): boolean {
  const subpath = relative(root, child);
  return subpath === '' || (subpath !== '..' && !subpath.startsWith(`..${sep}`) && !isAbsolute(subpath));
}
async function existingWithin(root: string, path: string, label: string): Promise<string> {
  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, path);
  if (!inside(rootReal, candidate)) throw new Error(`${label} escapes ${root}`);
  const candidateReal = await realpath(candidate);
  if (!inside(rootReal, candidateReal)) throw new Error(`${label} resolves outside ${root}`);
  return candidateReal;
}
function pluginRoot(plugin: LockedPlugin, apmHome: string): string {
  return join(apmHome, 'apm_modules', plugin.repo, plugin.path);
}
async function destinations(plugin: LockedPlugin, policy: PluginPolicy, home: string, apmHome: string): Promise<string[]> {
  const output = new Set<string>();
  const root = pluginRoot(plugin, apmHome);
  if (!policy.skill) {
    output.add(await existingWithin(join(apmHome, 'apm_modules'), join(plugin.repo, plugin.path), 'kept plugin'));
    if (plugin.nativePluginRoot) {
      const nativeBase = join(home, '.agents', 'plugins');
      if (plugin.nativePluginRoot.startsWith('.agents/plugins/')) output.add(await existingWithin(nativeBase, plugin.nativePluginRoot.slice('.agents/plugins/'.length), 'native plugin'));
    }
  } else {
    try {
      output.add(await existingWithin(root, `skills/${policy.skill}`, `kept skill ${policy.skill}`));
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (plugin.nativePluginRoot?.startsWith('.agents/plugins/')) {
      const nativeRoot = plugin.nativePluginRoot.slice('.agents/plugins/'.length);
      try {
        output.add(await existingWithin(join(home, '.agents', 'plugins'), `${nativeRoot}/skills/${policy.skill}`, `native skill ${policy.skill}`));
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    for (const file of plugin.deployedFiles) {
      const parts = file.split('/');
      const index = parts.lastIndexOf('skills');
      if (index < 0 || parts[index + 1] !== policy.skill) continue;
      const deployment = parts.slice(0, index + 2).join('/');
      const prefix = ['.agents/skills/', '.hermes/skills/', '.claude/skills/'].find((candidate) => deployment.startsWith(candidate));
      if (prefix) output.add(await existingWithin(home, deployment, `skill ${policy.skill}`));
    }
    if (output.size === 0) throw new Error(`no deployed copy found for skill ${policy.skill}`);
  }
  return [...output];
}
async function readState(path: string): Promise<State> {
  if (!existsSync(path)) return { version: 1, receipts: {} };
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('state must be an object');
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || !item.receipts || typeof item.receipts !== 'object' || Array.isArray(item.receipts)) throw new Error('unsupported state format');
  if (Object.values(item.receipts).some((receipt) => typeof receipt !== 'string')) throw new Error('invalid state receipt');
  return item as unknown as State;
}
async function saveState(path: string, state: State): Promise<void> {
  const temp = join(dirname(path), `.state-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    try {
      await unlink(temp);
    } catch {
      /* preserve original error */
    }
    throw error;
  }
}
function receiptKey(policy: PluginPolicy, destination: string): string {
  return JSON.stringify([recordId(policy), destination]);
}
function digest(policy: PluginPolicy, command: string): string {
  return createHash('sha256')
    .update(JSON.stringify([recordId(policy), command]))
    .digest('hex');
}
// The platform shell runs the configured string as written, as with npm and Node's `shell` option.
async function execute(command: string, cwd: string, environment: NodeJS.ProcessEnv): Promise<void> {
  await spawn(command, [], { cwd, env: environment, stdio: ['ignore', 'inherit', 'inherit'], shell: true });
}
function lockLoadError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
export async function runLifecycle(mode: Mode, options: RunOptions = {}): Promise<number> {
  const home = resolve(options.home ?? homedir());
  const apmHome = resolve(options.apmHome ?? join(home, '.apm'));
  const configPath = options.configPath ?? join(home, '.config', 'agent-plugin-lifecycle', 'config.json');
  const environment = options.environment ?? process.env;
  const output = options.output ?? console.log;
  const config = await loadConfig(configPath);
  let locked: LockedPlugin[];
  try {
    locked = await loadLock(join(apmHome, 'apm.lock.yaml'));
  } catch (error) {
    if (mode === 'run' && options.event?.event === 'post-uninstall' && lockLoadError(error)) {
      const apmDirectory = await stat(apmHome);
      if (!apmDirectory.isDirectory()) throw error;
      locked = [];
    } else throw error;
  }
  const statePath = join(dirname(configPath), 'state.json');
  if (mode === 'run') await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const release = mode === 'run' ? await lockfile.lock(dirname(statePath), { realpath: false }) : undefined;
  try {
    const state = await readState(statePath);
    let failed = 0;
    if (mode === 'run' && options.event?.event === 'post-uninstall') {
      const eventNames = new Set(options.event.packages.map(({ name }) => name));
      for (const policy of config.plugins) {
        const id = recordId(policy);
        const receiptKeys = Object.keys(state.receipts).filter((key) => {
          try {
            return JSON.parse(key)[0] === id;
          } catch {
            return false;
          }
        });
        if (!receiptKeys.length) continue;
        const sourceCandidate =
          policy.source.startsWith('.') || isAbsolute(policy.source) ? locked.find((plugin) => plugin.localPath !== undefined && samePath(policy.source, plugin.localPath)) : locked.find((plugin) => matchesSource(policy.source, plugin) && (plugin.path === (policy.path ?? '.') || plugin.localPath !== undefined));
        const sourcePartsValue = sourceParts(policy.source);
        const removedNameMatch =
          eventNames.has(sourceCandidate?.repo ?? '') ||
          eventNames.has(sourceCandidate ? `${sourceCandidate.host}/${sourceCandidate.repo}` : '') ||
          eventNames.has(sourcePartsValue?.repo ?? '') ||
          eventNames.has(sourcePartsValue ? `${sourcePartsValue.host}/${sourcePartsValue.repo}` : '') ||
          // APM names a removed subfolder plugin `owner/repo/<folder>` (install and update events name it `owner/repo`); exact match only, so removing one folder never matches another plugin of the repository
          (!!sourcePartsValue && !!policy.path && policy.path !== '.' && (eventNames.has(`${sourcePartsValue.repo}/${policy.path}`) || eventNames.has(`${sourcePartsValue.host}/${sourcePartsValue.repo}/${policy.path}`))) ||
          eventNames.has(localEventName(policy.source)) ||
          eventNames.has(policy.source);
        const anyStillInstalled = locked.some((plugin) => matchesSource(policy.source, plugin) && plugin.path === (policy.path ?? '.'));
        if (anyStillInstalled || !removedNameMatch) continue;
        const command = policy['post-uninstall'];
        if (!command) {
          for (const key of receiptKeys) delete state.receipts[key];
          await saveState(statePath, state);
          continue;
        }
        try {
          await execute(command, home, environment);
          for (const key of receiptKeys) delete state.receipts[key];
          await saveState(statePath, state);
          output(`cleaned ${id}`);
        } catch (error) {
          output(`failed cleanup ${id}: ${error instanceof Error ? error.message : String(error)}`);
          failed++;
        }
      }
      return failed ? 1 : 0;
    }
    if (mode === 'run' && !options.event) throw new Error('run requires an APM event');
    const event = options.event?.event ?? 'post-install';
    for (const policy of config.plugins) {
      const command = event === 'post-update' ? (policy['post-update'] ?? policy['post-install']) : policy['post-install'];
      if (!command) continue;
      const matches = locked.filter((plugin) => matchesSource(policy.source, plugin) && plugin.path === (policy.path ?? '.'));
      if (matches.length > 1) {
        output(`failed ambiguous source/path record ${recordId(policy)}`);
        failed++;
        continue;
      }
      if (!matches.length) {
        output(`skipped source not installed ${recordId(policy)}`);
        continue;
      }
      const plugin = matches[0];
      try {
        const found = await destinations(plugin, policy, home, apmHome);
        for (const destination of found) {
          const key = receiptKey(policy, destination);
          if (mode === 'check') {
            const validDigests = [policy['post-install'], policy['post-update']].filter((item): item is string => !!item).map((item) => digest(policy, item));
            const ready = validDigests.includes(state.receipts[key]);
            output(`${ready ? 'ok' : 'missing'} ${recordId(policy)} ${destination}`);
            if (!ready) failed++;
          } else {
            delete state.receipts[key];
            await saveState(statePath, state);
            await execute(command, destination, environment);
            state.receipts[key] = digest(policy, command);
            await saveState(statePath, state);
            output(`ran ${recordId(policy)} ${destination}`);
          }
        }
      } catch (error) {
        output(`failed ${recordId(policy)}: ${error instanceof Error ? error.message : String(error)}`);
        failed++;
      }
    }
    return failed ? 1 : 0;
  } finally {
    await release?.();
  }
}
