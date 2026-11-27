import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { APL_DIR, STATE_FILE } from './constants.ts';
import { isRecord } from './lib/object.ts';
import { readStore, updateStore } from './lib/store.ts';

/** The last successful run of `install` in one copy. `revision` and `lock` come from APM's lock and are absent for a named folder. */
export interface Run {
  id: string;
  install: string;
  revision?: string;
  lock?: string;
}
/** `~/.apl/state.json` without its `version`: one record per copy folder. */
export interface State {
  runs: Record<string, Run>;
}

export function parseState(value: Record<string, unknown>): State {
  const { runs } = value;
  if (!isRecord(runs)) throw new Error('runs must be an object');
  for (const [folder, entry] of Object.entries(runs)) {
    const run = entry as Partial<Run> | null;
    const optional = (field: unknown) => field === undefined || typeof field === 'string';
    if (!isRecord(run) || typeof run.id !== 'string' || typeof run.install !== 'string' || !optional(run.revision) || !optional(run.lock)) throw new Error(`run record for ${folder} must have id and install strings`);
  }
  return { runs: runs as Record<string, Run> };
}
const empty = (): State => ({ runs: {} });

/** The copy's record matches its command and revision; a named folder has no revision on either side. */
export function isCurrent(run: Run | undefined, install: string, revision: string | undefined): boolean {
  return !!run && run.install === install && run.revision === revision;
}

export function readState(home: string): Promise<State> {
  return readStore(join(home, APL_DIR, STATE_FILE), parseState, empty);
}

/** Changes the run records; records whose folder no longer exists are dropped in the same write. */
export function updateState(home: string, change: (state: State) => void): Promise<State> {
  return updateStore(join(home, APL_DIR), STATE_FILE, parseState, empty, (state) => {
    change(state);
    for (const folder of Object.keys(state.runs)) if (!existsSync(folder)) delete state.runs[folder];
  });
}
