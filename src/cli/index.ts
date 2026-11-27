import type { Command } from './types.ts';

// Lazy registry: a command's imports load only when it runs.
export const COMMANDS: Record<string, () => Promise<{ default: Command }>> = {
  install: () => import('./install.ts'),
  status: () => import('./status.ts'),
};

export type { Command, Ctx } from './types.ts';
