import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INSTALL, MANIFEST } from './constants.ts';
import { withoutBom } from './lib/errors.ts';
import { isRecord } from './lib/object.ts';

/** The `install` command of a parsed `apl.json`, or undefined when it has none. Unknown fields are ignored. */
export function parseManifest(value: unknown): string | undefined {
  if (!isRecord(value)) throw new Error(`${MANIFEST} must be an object`);
  const { scripts } = value;
  if (scripts === undefined) return undefined;
  if (!isRecord(scripts)) throw new Error(`${MANIFEST} scripts must be an object`);
  const install = scripts[INSTALL];
  if (install === undefined) return undefined;
  if (typeof install !== 'string' || !install.trim()) throw new Error(`${MANIFEST} scripts.${INSTALL} must be a nonempty string`);
  return install;
}

/** Reads `<folder>/apl.json`. A missing file rejects with the `ENOENT` error; an invalid one with a message naming the problem. */
export async function readManifest(folder: string): Promise<string | undefined> {
  const text = await readFile(join(folder, MANIFEST), 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(withoutBom(text));
  } catch (error) {
    throw new Error(`${MANIFEST} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseManifest(value);
}
