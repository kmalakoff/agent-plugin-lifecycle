import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';
import { FILE_VERSION, LOCK_NAME, LOCK_RETRIES } from '../constants.ts';
import { message, missing, withoutBom } from './errors.ts';
import { isRecord } from './object.ts';

/** Checks the content of one store file (without its `version`), throwing when it is not the expected shape. */
export type Parse<T> = (value: Record<string, unknown>) => T;

function check<T>(path: string, value: unknown, parse: Parse<T>): T {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (value.version !== FILE_VERSION) throw new Error(`${path} has unsupported version ${JSON.stringify(value.version)}`);
  try {
    return parse(value);
  } catch (error) {
    throw new Error(`${path}: ${message(error)}`);
  }
}

/** On macOS and Linux, `path` (when it exists) must be the user's and not writable by group or others, as OpenSSH requires of `~/.ssh`. */
async function checkPrivate(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (info.uid !== process.getuid?.()) throw new Error(`${path} is not owned by you`);
  if (info.mode & 0o022) throw new Error(`${path} is writable by group or others: run chmod go-w ${path}`);
}

/** Reads a store file; a file that does not exist reads as `empty()`. The folder and the file must be private (`checkPrivate`). */
export async function readStore<T>(path: string, parse: Parse<T>, empty: () => T): Promise<T> {
  await checkPrivate(dirname(path));
  await checkPrivate(path);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (missing(error)) return empty();
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(withoutBom(text));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${message(error)}`);
  }
  return check(path, value, parse);
}

/**
 * Changes one store file in `dir` while holding the folder's lock: reads the current content, lets `change` edit it, and writes it
 * under a temporary name renamed into place. Any failure to create or write `dir` names the folder.
 */
export async function updateStore<T>(dir: string, file: string, parse: Parse<T>, empty: () => T, change: (value: T) => void): Promise<T> {
  const path = join(dir, file);
  let release: () => Promise<void>;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`cannot write ${dir}: ${message(error)}`);
  }
  // before the lock, which proper-lockfile creates inside the folder
  await checkPrivate(dir);
  try {
    release = await lockfile.lock(dir, { realpath: false, lockfilePath: join(dir, LOCK_NAME), retries: LOCK_RETRIES });
  } catch (error) {
    throw new Error(`cannot write ${dir}: ${message(error)}`);
  }
  try {
    const value = await readStore(path, parse, empty);
    change(value);
    try {
      // written under a temporary name and renamed into place, private to the user
      await writeFileAtomic(path, `${JSON.stringify({ version: FILE_VERSION, ...value }, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      throw new Error(`cannot write ${dir}: ${message(error)}`);
    }
    return value;
  } finally {
    await release();
  }
}
