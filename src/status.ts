import { existsSync } from 'node:fs';
import { isApproved, readApprovals } from './approvals.ts';
import { cannotRun, findCopies } from './copies.ts';
import { resolveOptions } from './lib/options.ts';
import { isCurrent, readState } from './state.ts';
import type { CopyResult, StatusOptions } from './types.ts';

/** Reports each copy without changing anything; for an APM scope, also each folder a script ran in whose package APM has since removed (`left`). */
export async function status(options: StatusOptions = {}): Promise<CopyResult[]> {
  const { home, apmHome, cwd, global, folders } = resolveOptions(options);
  const { copies, scope, named } = await findCopies({ home, apmHome, cwd, global, folders });
  const approvals = await readApprovals(home);
  const state = await readState(home);
  const results: CopyResult[] = copies.map((copy): CopyResult => {
    const { id, folder, place, install, revision } = copy;
    if (install === undefined) return cannotRun(copy);
    if (!isApproved(approvals, place, id, install)) return { status: 'unapproved', id, folder };
    const run = state.runs[folder];
    if (!run) return { status: 'missing', id, folder };
    return { status: isCurrent(run, install, revision) ? 'ok' : 'stale', id, folder };
  });
  if (scope) {
    for (const [folder, run] of Object.entries(state.runs)) if (run.lock === scope.lock && !named.has(folder) && existsSync(folder)) results.push({ status: 'left', folder });
  }
  return results;
}
