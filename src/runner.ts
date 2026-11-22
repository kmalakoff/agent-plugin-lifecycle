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
// `revision` is the locked revision the command last ran against; '' is a version 1 receipt, whose revision was never recorded.
interface Receipt {
  digest: string;
  revision: string;
}
interface State {
  version: 2;
  receipts: Record<string, Receipt>;
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
function missing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
async function existingOrNone(root: string, path: string, label: string): Promise<string | undefined> {
  try {
    return await existingWithin(root, path, label);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
const SKILL_ROOTS = ['.agents/skills/', '.hermes/skills/', '.claude/skills/'];
function deployedSkillFolders(plugin: LockedPlugin, skill: string): string[] {
  const folders = new Set<string>();
  for (const file of plugin.deployedFiles) {
    const parts = file.split('/');
    const index = parts.lastIndexOf('skills');
    if (index < 0 || parts[index + 1] !== skill) continue;
    const deployment = parts.slice(0, index + 2).join('/');
    if (SKILL_ROOTS.some((candidate) => deployment.startsWith(candidate))) folders.add(deployment);
  }
  return [...folders];
}
// APM's kept copy (`apm_modules/...`) is a destination only when the lock names no other copy: a target such as copilot reads it in place.
// When the lock names a native plugin root or deployed skill copies, the kept copy is APM's cache and is never used, even if the listed copies are missing on disk (they are skipped, and check reports them).
async function destinations(plugin: LockedPlugin, policy: PluginPolicy, home: string, apmHome: string): Promise<string[]> {
  const found = new Set<string>();
  const add = (path: string | undefined) => {
    if (path) found.add(path);
  };
  const nativeRoot = plugin.nativePluginRoot?.startsWith('.agents/plugins/') ? plugin.nativePluginRoot.slice('.agents/plugins/'.length) : undefined;
  if (!policy.skill) {
    if (!nativeRoot) return [await existingWithin(join(apmHome, 'apm_modules'), join(plugin.repo, plugin.path), 'kept plugin')];
    add(await existingOrNone(join(home, '.agents', 'plugins'), nativeRoot, 'native plugin'));
    if (!found.size) throw new Error(`no native plugin copy found for ${plugin.repo}`);
    return [...found];
  }
  const deployed = deployedSkillFolders(plugin, policy.skill);
  if (!nativeRoot && !deployed.length) {
    const kept = await existingOrNone(pluginRoot(plugin, apmHome), `skills/${policy.skill}`, `kept skill ${policy.skill}`);
    if (!kept) throw new Error(`no deployed copy found for skill ${policy.skill}`);
    return [kept];
  }
  if (nativeRoot) add(await existingOrNone(join(home, '.agents', 'plugins'), `${nativeRoot}/skills/${policy.skill}`, `native skill ${policy.skill}`));
  for (const deployment of deployed) add(await existingOrNone(home, deployment, `skill ${policy.skill}`));
  if (!found.size) throw new Error(`no deployed copy found for skill ${policy.skill}`);
  return [...found];
}
async function readState(path: string): Promise<State> {
  if (!existsSync(path)) return { version: 2, receipts: {} };
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('state must be an object');
  const item = value as Record<string, unknown>;
  if ((item.version !== 1 && item.version !== 2) || !item.receipts || typeof item.receipts !== 'object' || Array.isArray(item.receipts)) throw new Error('unsupported state format');
  const receipts: Record<string, Receipt> = {};
  for (const [key, receipt] of Object.entries(item.receipts)) {
    if (item.version === 1 && typeof receipt === 'string') receipts[key] = { digest: receipt, revision: '' };
    else if (item.version === 2 && receipt && typeof receipt === 'object' && typeof (receipt as Receipt).digest === 'string' && typeof (receipt as Receipt).revision === 'string') receipts[key] = receipt as Receipt;
    else throw new Error('invalid state receipt');
  }
  return { version: 2, receipts };
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
function receiptRecord(key: string): string | undefined {
  try {
    return JSON.parse(key)[0];
  } catch {
    return undefined;
  }
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
    } else if (mode === 'check' && lockLoadError(error)) {
      output('nothing installed');
      return 0;
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
        // APM keeps a folder holding files it did not write; report it, delete nothing
        for (const key of receiptKeys) {
          const destination: string = JSON.parse(key)[1];
          if (existsSync(destination)) output(`left ${destination}`);
        }
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
    let installed = 0;
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
        if (mode === 'run') output(`skipped source not installed ${recordId(policy)}`);
        continue;
      }
      installed++;
      const plugin = matches[0];
      const id = recordId(policy);
      try {
        const recorded = Object.keys(state.receipts).filter((key) => receiptRecord(key) === id);
        let found: string[];
        try {
          found = await destinations(plugin, policy, home, apmHome);
        } catch (error) {
          // check still reports a copy that was recorded and is now gone
          if (mode === 'check' && recorded.length && (missing(error) || (error instanceof Error && error.message.startsWith('no ')))) found = [];
          else throw error;
        }
        const gone = recorded.filter((key) => !existsSync(JSON.parse(key)[1]));
        if (mode === 'run') {
          // a copy that no longer exists loses its receipt, so the copy APM recreates in its place runs again
          for (const key of gone) delete state.receipts[key];
          if (gone.length) await saveState(statePath, state);
        } else {
          const validDigests = [policy['post-install'], policy['post-update']].filter((item): item is string => !!item).map((item) => digest(policy, item));
          for (const key of gone) {
            const receipt = state.receipts[key];
            if (validDigests.includes(receipt.digest) && receipt.revision === plugin.revision) {
              output(`broken ${id} ${JSON.parse(key)[1]}`);
              failed++;
            }
          }
          for (const destination of found) {
            const receipt = state.receipts[receiptKey(policy, destination)];
            let status = 'missing';
            if (receipt) {
              const current = validDigests.includes(receipt.digest) && receipt.revision === plugin.revision;
              status = current ? 'ok' : 'stale';
            }
            output(`${status} ${id} ${destination}`);
            if (status !== 'ok') failed++;
          }
          continue;
        }
        for (const destination of found) {
          const key = receiptKey(policy, destination);
          const wanted = digest(policy, command);
          const receipt = state.receipts[key];
          if (receipt && receipt.digest === wanted && receipt.revision === plugin.revision) {
            output(`current ${id} ${destination}`);
            continue;
          }
          delete state.receipts[key];
          await saveState(statePath, state);
          await execute(command, destination, environment);
          state.receipts[key] = { digest: wanted, revision: plugin.revision };
          await saveState(statePath, state);
          output(`ran ${id} ${destination}`);
        }
      } catch (error) {
        output(`failed ${id}: ${error instanceof Error ? error.message : String(error)}`);
        failed++;
      }
    }
    if (mode === 'check' && !installed && !failed) output('nothing installed');
    return failed ? 1 : 0;
  } finally {
    await release?.();
  }
}
