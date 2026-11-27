import { STATUSES } from '../../src/constants.ts';
import type { Status } from '../../src/types.ts';

/** One result line `apl install` or `apl status` printed, with each field read back as text. */
export interface Line {
  text: string;
  status: Status;
  id?: string;
  folder: string;
  reason?: string;
}

/**
 * Reads one field from `start`, the way a script reading apl's output would: a field that starts with `"` is a JSON string, read to its
 * closing quote and decoded; any other field has no space and runs to the next space or the end of the line. Returns the field and the
 * index just after it.
 */
function field(text: string, start: number): [string, number] {
  if (text[start] !== '"') {
    const space = text.indexOf(' ', start);
    const end = space < 0 ? text.length : space;
    return [text.slice(start, end), end];
  }
  let end = start + 1;
  while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
  return [JSON.parse(text.slice(start, end + 1)) as string, end + 1];
}

/**
 * The result lines in a CLI's output; other lines (`nothing installed`) are passed over. Each line is `<status> <id> <folder>`,
 * `failed <id> <folder>: <reason>`, `skipped <id> <folder>: <reason>` or `left <folder>`; the reason, last, is a JSON string or the rest of the line.
 */
export function parseLines(output: string): Line[] {
  const lines: Line[] = [];
  for (const text of output.split(/\r?\n/)) {
    // the status is a plain word; script output on other lines is never decoded
    const afterStatus = text.indexOf(' ');
    const status = text.slice(0, afterStatus);
    if (afterStatus < 0 || !(STATUSES as string[]).includes(status)) continue;
    if (status === 'left') {
      lines.push({ text, status, folder: field(text, afterStatus + 1)[0] });
      continue;
    }
    const [id, afterId] = field(text, afterStatus + 1);
    const [rawFolder, afterFolder] = field(text, afterId + 1);
    if (status !== 'failed' && status !== 'skipped') {
      lines.push({ text, status: status as Status, id, folder: rawFolder });
      continue;
    }
    // `failed` and `skipped` end `<folder>: <reason>`: a plain folder carries the colon with it; a JSON-string folder is followed by it
    const quoted = text[afterId + 1] === '"';
    const folder = quoted ? rawFolder : rawFolder.slice(0, -1);
    const rest = text.slice(quoted ? afterFolder + 2 : afterFolder + 1);
    lines.push({ text, status, id, folder, reason: rest.startsWith('"') ? (JSON.parse(rest) as string) : rest });
  }
  return lines;
}
