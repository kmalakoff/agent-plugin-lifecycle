import jsesc from 'jsesc';

// printable ASCII only: U+0020 to U+007E
const PRINTABLE = /^[ -~]*$/;

export interface VisibleOptions {
  /** The value is one space-separated field of a result line, so a value with a space also takes the JSON-string form. */
  field?: boolean;
}

/**
 * `value` as it is when it is printable ASCII with no leading or trailing space, does not start with `"` (and, for a `field`, has no space);
 * otherwise as a JSON string (`jsesc`). Only a JSON string starts with `"`, so the terminal shows exactly the text that is approved and run.
 */
export function visible(value: string, options: VisibleOptions = {}): string {
  const plain = PRINTABLE.test(value) && value.trim() === value && !value.startsWith('"') && !(options.field && value.includes(' '));
  return plain ? value : jsesc(value, { json: true });
}
