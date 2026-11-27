// Parsing and dispatch only. Commands live in src/cli/, one file each, lazy-loaded.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from './cli/index.ts';
import type { Ctx } from './cli/types.ts';
import { INSTALL_USAGE, STATUS_USAGE } from './cli/usage.ts';
import { EXIT_ERROR } from './constants.ts';
import { message } from './lib/errors.ts';
import { visible } from './lib/visible.ts';

// __dirname (CJS) or its ESM equivalent; dist/<format>/cli.js is two hops below the package root
const __dirname = path.dirname(typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url));

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

function usage(name: string): string {
  return `usage: ${name} ${INSTALL_USAGE}   run install scripts, asking before any that are not approved
       ${name} ${STATUS_USAGE}           report each copy; exit 1 unless every copy is ok
       ${name} --help | -h
       ${name} --version | -v

With no folder, the copies are the ones APM's lock names: ./apm.lock.yaml, or with -g (or run in the APM home) ~/.apm/apm.lock.yaml.
Approvals and run records: ~/.apl/`;
}

/** Prints apl's own text, with any untrusted part already escaped, and exits 2. */
function fail(text: string): never {
  console.error(text);
  process.exit(EXIT_ERROR);
}

/** Runs the CLI; sets `process.exitCode` to 0, 1 (a copy is not ok) or 2 (apl could not do its work). */
export default async function cli(argv: string[], name: string): Promise<void> {
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(packageVersion());
    return;
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(usage(name));
    return;
  }
  const load = COMMANDS[argv[0]];
  if (!load) fail(`${argv.length ? `unknown command: ${visible(argv[0])}\n` : ''}${usage(name)}`);
  const ctx: Ctx = { name, rest: argv.slice(1), usageError: fail };
  try {
    process.exitCode = await (await load()).default(ctx);
  } catch (error) {
    // the message can carry a hostile lock's text or a folder's name: escaped as a whole, so a newline in it cannot start a line
    fail(`${name}: ${visible(message(error))}`);
  }
}
