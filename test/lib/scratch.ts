import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { packageRoot } from './apm-live.ts';

/** A fresh folder under the package's .tmp/; remove it with removeAccount (fs-remove-compat) when done. */
export async function scratch(prefix: string): Promise<string> {
  await mkdir(join(packageRoot, '.tmp'), { recursive: true });
  return mkdtemp(join(packageRoot, '.tmp', `${prefix}-`));
}
