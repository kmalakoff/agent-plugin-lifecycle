import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { APM_DIR } from '../constants.ts';
import type { StatusOptions } from '../types.ts';

export interface Resolved {
  home: string;
  apmHome: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  global: boolean;
  folders?: string[];
}

export function resolveOptions(options: StatusOptions): Resolved {
  const home = resolve(options.home ?? homedir());
  return {
    home,
    apmHome: resolve(options.apmHome ?? join(home, APM_DIR)),
    cwd: resolve(options.cwd ?? process.cwd()),
    environment: options.environment ?? process.env,
    global: !!options.global,
    folders: options.folders,
  };
}
