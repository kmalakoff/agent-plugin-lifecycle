import { EXIT_NOT_OK, EXIT_OK, NOTHING_INSTALLED, SUCCESS_STATUSES } from '../constants.ts';
import { visible } from '../lib/visible.ts';
import type { CopyResult } from '../types.ts';

/** One result line, escaped as the question is; the id and folder have no space or are JSON strings, and the reason, last, may hold spaces. */
export function line(result: CopyResult): string {
  const folder = visible(result.folder, { field: true });
  if (result.status === 'left') return `left ${folder}`;
  const id = visible(result.id ?? '', { field: true });
  if (result.status === 'failed' || result.status === 'skipped') return `${result.status} ${id} ${folder}: ${visible(result.reason ?? '')}`;
  return `${result.status} ${id} ${folder}`;
}

export function print(result: CopyResult): void {
  console.log(line(result));
}

/** Prints `nothing installed` when no copy was found, and returns the exit code. */
export function summarize(results: CopyResult[]): number {
  if (!results.some((result) => result.status !== 'left')) console.log(NOTHING_INSTALLED);
  return results.every((result) => SUCCESS_STATUSES.includes(result.status)) ? EXIT_OK : EXIT_NOT_OK;
}
