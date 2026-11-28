import { type Approved, isApproved, readApprovals, saveApprovals } from './approvals.ts';
import { cannotRun, findCopies } from './copies.ts';
import { message } from './lib/errors.ts';
import { resolveOptions } from './lib/options.ts';
import { runScript } from './lib/run.ts';
import { computeStamp, isCurrent, readState, updateState } from './state.ts';
import type { ApprovalRequest, CopyResult, InstallOptions } from './types.ts';

/**
 * Runs the `install` script of every copy approved in its place and not already current, asking `approve` first, once per id and command.
 * A copy from APM is current when its last successful run matches its command and stamp; a named folder always runs.
 */
export async function install(options: InstallOptions = {}): Promise<CopyResult[]> {
  const { home, apmHome, cwd, environment, global, folders } = resolveOptions(options);
  const { copies } = await findCopies({ home, apmHome, cwd, global, folders });
  let approvals = await readApprovals(home);
  if (options.approve) {
    // one request per place, id and command; the approval is saved under that place
    const requests = new Map<string, { place: string; request: ApprovalRequest }>();
    for (const { id, folder, place, install } of copies) {
      if (install === undefined || isApproved(approvals, place, id, install)) continue;
      const key = JSON.stringify([place, id, install]);
      const pending = requests.get(key) ?? { place, request: { id, scripts: { install }, folders: [] } };
      pending.request.folders.push(folder);
      requests.set(key, pending);
    }
    const approved: Approved[] = [];
    for (const { place, request } of requests.values()) if (await options.approve(request)) approved.push({ place, id: request.id, install: request.scripts.install });
    // saved after the last answer, so a run interrupted at a question saves nothing
    if (approved.length) approvals = await saveApprovals(home, approved);
  }
  const state = await readState(home);
  const results: CopyResult[] = [];
  const done = (result: CopyResult) => {
    results.push(result);
    options.onResult?.(result);
  };
  for (const copy of copies) {
    const { id, folder, place, install, revision, lock } = copy;
    if (install === undefined) {
      done(cannotRun(copy));
      continue;
    }
    if (!isApproved(approvals, place, id, install)) {
      done({ status: 'unapproved', id, folder });
      continue;
    }
    const run = state.runs[folder];
    if (revision !== undefined && run && isCurrent(run, install, await computeStamp(folder, revision))) {
      done({ status: 'current', id, folder });
      continue;
    }
    // no record while the script runs, so a failed or killed run leaves the copy missing
    await updateState(home, (value) => {
      delete value.runs[folder];
    });
    try {
      await runScript(install, folder, environment);
    } catch (failure) {
      done({ status: 'failed', id, folder, reason: message(failure) });
      continue;
    }
    const stamp = await computeStamp(folder, revision);
    await updateState(home, (value) => {
      value.runs[folder] = { id, install, stamp, ...(lock === undefined ? {} : { lock }) };
    });
    done({ status: 'ran', id, folder });
  }
  return results;
}
