import { join } from 'node:path';
import { APL_DIR, APPROVALS_FILE } from './constants.ts';
import { isRecord } from './lib/object.ts';
import { readStore, updateStore } from './lib/store.ts';

export interface Approval {
  scripts: { install: string };
  /** ISO time the approval was given. */
  approved: string;
}
/**
 * `~/.apl/approvals.json` without its `version`: for each place (the real path of the project folder, of the APM home, or of a
 * named folder), one entry per id.
 */
export interface Approvals {
  approvals: Record<string, Record<string, Approval>>;
}

export function parseApprovals(value: Record<string, unknown>): Approvals {
  const { approvals } = value;
  if (!isRecord(approvals)) throw new Error('approvals must be an object');
  for (const [place, entries] of Object.entries(approvals)) {
    if (!isRecord(entries)) throw new Error(`approvals for ${place} must be an object`);
    for (const [id, entry] of Object.entries(entries)) {
      const item = entry as Partial<Approval> | null;
      if (!isRecord(item) || !isRecord(item.scripts) || typeof item.scripts.install !== 'string' || typeof item.approved !== 'string') throw new Error(`approval for ${id} in ${place} must have scripts.install and approved strings`);
    }
  }
  return { approvals: approvals as Approvals['approvals'] };
}
const empty = (): Approvals => ({ approvals: {} });

/** The command text approved for `id` in `place` equals `install`. An approval in any other place does not count. */
export function isApproved(approvals: Approvals, place: string, id: string, install: string): boolean {
  if (!Object.hasOwn(approvals.approvals, place)) return false;
  const entries = approvals.approvals[place];
  return Object.hasOwn(entries, id) && entries[id].scripts.install === install;
}

export function readApprovals(home: string): Promise<Approvals> {
  return readStore(join(home, APL_DIR, APPROVALS_FILE), parseApprovals, empty);
}

/** One approval given: `install` approved for `id` in `place`. */
export interface Approved {
  place: string;
  id: string;
  install: string;
}
/** Saves the approvals in one write, each replacing any earlier entry for its place and id. */
export async function saveApprovals(home: string, approved: Approved[], now: Date = new Date()): Promise<Approvals> {
  return updateStore(join(home, APL_DIR), APPROVALS_FILE, parseApprovals, empty, (value) => {
    for (const { place, id, install } of approved) {
      const entries = Object.hasOwn(value.approvals, place) ? value.approvals[place] : {};
      entries[id] = { scripts: { install }, approved: now.toISOString() };
      value.approvals[place] = entries;
    }
  });
}
