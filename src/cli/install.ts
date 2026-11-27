import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { EXIT_INTERRUPTED } from '../constants.ts';
import { install } from '../install.ts';
import { message } from '../lib/errors.ts';
import { visible } from '../lib/visible.ts';
import type { ApprovalRequest } from '../types.ts';
import { print, summarize } from './report.ts';
import type { Ctx } from './types.ts';
import { INSTALL_USAGE as USAGE } from './usage.ts';

const parse = (args: string[]) => parseArgs({ args, allowPositionals: true, options: { global: { type: 'boolean', short: 'g' }, yes: { type: 'boolean', short: 'y' }, help: { type: 'boolean', short: 'h' } } });

/** What the question prints before the prompt. */
export function requestText(request: ApprovalRequest): string {
  return `${visible(request.id)} wants to run\n  install: ${visible(request.scripts.install)}\nin\n${request.folders.map((folder) => `  ${visible(folder)}\n`).join('')}`;
}
export const PROMPT = 'Run it? [y/N] ';

export interface QuestionStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Called on Ctrl+C at the question; the CLI exits 130 there, before any approval is saved or any script runs. */
  interrupt: () => void;
}
/**
 * The approval question as an `approve` function, with a readline interface per question so the terminal is normal again while scripts
 * run. `y` or `yes` approves; anything else, or end of input (Ctrl+D), answers no.
 */
export function questioner({ input, output, interrupt }: QuestionStreams): (request: ApprovalRequest) => Promise<boolean> {
  return async (request) => {
    output.write(requestText(request));
    const terminal = createInterface({ input, output });
    terminal.on('SIGINT', () => {
      output.write('\n');
      interrupt();
    });
    try {
      // a pending question does not always settle when input ends, so the interface closing answers it first
      const answer = await new Promise<string | undefined>((resolve, reject) => {
        terminal.on('close', () => resolve(undefined));
        terminal.question(PROMPT).then(resolve, reject);
      });
      if (answer === undefined) output.write('\n');
      return answer !== undefined && ['y', 'yes'].includes(answer.trim().toLowerCase());
    } finally {
      terminal.close();
    }
  };
}

export default async function installCommand(ctx: Ctx): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(ctx.rest);
  } catch (error) {
    return ctx.usageError(`${visible(message(error))}\nusage: ${ctx.name} ${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(`usage: ${ctx.name} ${USAGE}\n\nRuns the install script in each copy, asking before any that is not approved.\n  -g, --global  the user scope (~/.apm) instead of the project here\n  -y, --yes     approve every unapproved script without asking`);
    return 0;
  }
  if (values.global && positionals.length) return ctx.usageError(`-g cannot be combined with folders\nusage: ${ctx.name} ${USAGE}`);
  // the question needs a terminal on both standard input and output; without one, unapproved copies are only reported
  const ask = questioner({ input: process.stdin, output: process.stdout, interrupt: () => process.exit(EXIT_INTERRUPTED) });
  const approve = values.yes ? async () => true : process.stdin.isTTY && process.stdout.isTTY ? ask : undefined;
  // each line is printed as its result is known, so a run killed part-way shows what finished
  return summarize(await install({ global: values.global, folders: positionals, apmHome: process.env.APM_HOME || undefined, approve, onResult: print }));
}
