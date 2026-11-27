import { parseArgs } from 'node:util';
import { message } from '../lib/errors.ts';
import { visible } from '../lib/visible.ts';
import { status } from '../status.ts';
import { print, summarize } from './report.ts';
import type { Ctx } from './types.ts';
import { STATUS_USAGE as USAGE } from './usage.ts';

const parse = (args: string[]) => parseArgs({ args, allowPositionals: true, options: { global: { type: 'boolean', short: 'g' }, help: { type: 'boolean', short: 'h' } } });

export default async function statusCommand(ctx: Ctx): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(ctx.rest);
  } catch (error) {
    return ctx.usageError(`${visible(message(error))}\nusage: ${ctx.name} ${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(`usage: ${ctx.name} ${USAGE}\n\nReports each copy and changes nothing; exits 1 unless every copy is ok.\n  -g, --global  the user scope (~/.apm) instead of the project here`);
    return 0;
  }
  if (values.global && positionals.length) return ctx.usageError(`-g cannot be combined with folders\nusage: ${ctx.name} ${USAGE}`);
  const results = await status({ global: values.global, folders: positionals, apmHome: process.env.APM_HOME || undefined });
  for (const result of results) print(result);
  return summarize(results);
}
