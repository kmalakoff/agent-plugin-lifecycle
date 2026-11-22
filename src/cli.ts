import { parseArgs } from 'node:util';

import { runLifecycle } from './runner.js';

const HELP = `agent-plugin-lifecycle

Usage:
  agent-plugin-lifecycle run         Dispatch an APM post-install/update/uninstall event from stdin
  agent-plugin-lifecycle check       Report missing or failed plugin setup
  agent-plugin-lifecycle --help

Policy: ~/.config/agent-plugin-lifecycle/config.json
APM lock: ~/.apm/apm.lock.yaml (or $APM_HOME/apm.lock.yaml)
`;

async function readEvent(): Promise<import('./runner.js').LifecycleEvent> {
  if (process.stdin.isTTY) throw new Error('run requires an APM event on stdin');
  let payload = '';
  for await (const chunk of process.stdin) {
    payload += chunk.toString();
    if (payload.length > 1024 * 1024) throw new Error('APM event exceeds 1 MiB');
  }
  if (!payload.trim()) throw new Error('run requires an APM event on stdin');
  const event: unknown = JSON.parse(payload);
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('APM event must be an object');
  const value = event as Record<string, unknown>;
  if (
    value.schema_version !== 1 ||
    !['post-install', 'post-update', 'post-uninstall'].includes(String(value.event)) ||
    !['user', 'project'].includes(String(value.scope)) ||
    !Array.isArray(value.packages) ||
    !value.packages.every((p) => p && typeof p === 'object' && typeof p.name === 'string' && (p.reference === null || typeof p.reference === 'string'))
  ) {
    throw new Error('unsupported APM lifecycle event');
  }
  return value as unknown as import('./runner.js').LifecycleEvent;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  if (positionals.length !== 1 || !['run', 'check'].includes(positionals[0])) throw new Error('expected run or check; use --help');
  const event = positionals[0] === 'run' ? await readEvent() : undefined;
  if (event?.scope !== undefined && event.scope !== 'user') {
    console.log(`skipped APM ${event.scope} scope event`);
    return 0;
  }
  return runLifecycle(positionals[0] as 'run' | 'check', { apmHome: process.env.APM_HOME, event });
}

main()
  .then((status) => {
    process.exitCode = status;
  })
  .catch((error: unknown) => {
    console.error(`agent-plugin-lifecycle: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
