/** A path, or a parent of it, does not exist. */
export function missing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Text without a leading UTF-8 byte order mark, which some Windows editors write and `JSON.parse` rejects. */
export function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
