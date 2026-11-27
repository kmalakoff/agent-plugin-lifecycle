/** `value` is a plain object, as JSON and YAML parse one: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
