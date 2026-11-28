import { existsSync } from 'node:fs';
import { isApproved, readApprovals } from './approvals.ts';
import { cannotRun, findCopies } from './copies.ts';
import { resolveOptions } from './lib/options.ts';
import { computeStamp, isCurrent, readState } from './state.ts';
import type { CopyResult, StatusOptions } from './types.ts';

/** Reports each copy without changing anything; for an APM scope, also each folder a script ran in whose package APM has since removed (`left`). */
export async function status(options: StatusOptions = {}): Promise<CopyResult[]> {
  const { home, apmHome, cwd, global, folders } = resolveOptions(options);
  const { copies, scope, named } = await findCopies({ home, apmHome, cwd, global, folders });
  const approvals = await readApprovals(home);
  const state = await readState(home);
  const results: CopyResult[] = [];
  for (const copy of copies) {
    const { id, folder, place, install, revision } = copy;
    if (install === undefined) {
      results.push(cannotRun(copy));
      continue;
    }
    if (!isApproved(approvals, place, id, install)) {
      results.push({ status: 'unapproved', id, folder });
      continue;
    }
    const run = state.runs[folder];
    if (!run) {
      results.push({ status: 'missing', id, folder });
      continue;
    }
    results.push({ status: isCurrent(run, install, await computeStamp(folder, revision)) ? 'ok' : 'stale', id, folder });
  }
  if (scope) {
    for (const [folder, run] of Object.entries(state.runs)) if (run.lock === scope.lock && !named.has(folder) && existsSync(folder)) results.push({ status: 'left', folder });
  }
  return results;
}
