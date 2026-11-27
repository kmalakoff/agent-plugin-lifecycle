/** What `install` (`ran`, `current`, `unapproved`, `failed`, `skipped`) or `status` (`ok`, `missing`, `stale`, `unapproved`, `failed`, `skipped`, `left`) reports for one copy; `left` is a folder. */
export type Status = 'ran' | 'current' | 'unapproved' | 'failed' | 'skipped' | 'ok' | 'missing' | 'stale' | 'left';

export interface Options {
  /** Default `os.homedir()`; `~/.apl` and user-scope copies live under it. */
  home?: string;
  /** Default `<home>/.apm`. */
  apmHome?: string;
  /** Default `process.cwd()`; the project root. */
  cwd?: string;
  /** The environment scripts run with. Default `process.env`. */
  environment?: NodeJS.ProcessEnv;
}
export interface StatusOptions extends Options {
  /** Use the user scope (`apmHome`) instead of the project in `cwd`. Not allowed with `folders`. */
  global?: boolean;
  /** Named folders, each holding an `apl.json`, instead of the copies APM's lock names. */
  folders?: string[];
}
export interface InstallOptions extends StatusOptions {
  /** Asked once per id whose command is not approved, before any script runs; the approvals are saved after the last answer. Absent: unapproved copies are not run. */
  approve?: (request: ApprovalRequest) => Promise<boolean>;
  /** Called with each result as soon as it is known, before the next script starts. */
  onResult?: (result: CopyResult) => void;
}
export interface ApprovalRequest {
  id: string;
  scripts: { install: string };
  folders: string[];
}
export interface CopyResult {
  status: Status;
  /** Absent only for `left`. */
  id?: string;
  folder: string;
  /** Why a copy `failed` or was `skipped`. */
  reason?: string;
}
