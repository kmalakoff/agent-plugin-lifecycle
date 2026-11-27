import type { Status } from './types.ts';

/** The file a plugin or skill ships its scripts in. */
export const MANIFEST = 'apl.json';
/** The one script name `apl` runs. */
export const INSTALL = 'install';

/** The per-user folder under the home that holds approvals and run records. */
export const APL_DIR = '.apl';
export const APPROVALS_FILE = 'approvals.json';
export const STATE_FILE = 'state.json';
/** The lock taken on `~/.apl` while either file changes (a folder `proper-lockfile` creates inside it). */
export const LOCK_NAME = 'lock';
/** Waits for another `apl` holding the lock; each hold is one read-modify-write of a small file. */
export const LOCK_RETRIES = { retries: 10, minTimeout: 50, maxTimeout: 500 };
/** The `version` of the files `apl` writes. */
export const FILE_VERSION = 1;

export const APM_DIR = '.apm';
export const APM_LOCK = 'apm.lock.yaml';
export const APM_MODULES = 'apm_modules';
/** The folder of a plugin's skills, and the part of an id for a skill: `skills/<name>`. */
export const SKILLS = 'skills';
/** The reason for a package whose `apl.json` reaches only APM's cache, which APM restores on `apm update`, deleting a script's output. */
export const CACHE_ONLY = "APM's cache is the only copy; scripts do not run there";

// true for the statuses that leave the exit code at 0; typed so the compiler holds it to exactly the Status union
const STATUS_SUCCESS: Record<Status, boolean> = { ran: true, current: true, ok: true, skipped: true, left: true, unapproved: false, failed: false, missing: false, stale: false };
export const STATUSES = Object.keys(STATUS_SUCCESS) as Status[];
export const SUCCESS_STATUSES = STATUSES.filter((status) => STATUS_SUCCESS[status]);

export const EXIT_OK = 0;
export const EXIT_NOT_OK = 1;
export const EXIT_ERROR = 2;
/** Ctrl+C at the approval question: 128 + SIGINT, as shells report it. */
export const EXIT_INTERRUPTED = 130;

export const NOTHING_INSTALLED = 'nothing installed';
export const NO_PROJECT_LOCK = 'no apm.lock.yaml here: pass -g or a folder';
