// Handed to every command; the command word is peeled off in src/cli.ts and each command parses its own flags from `rest`.
export interface Ctx {
  /** binary name, for usage strings */
  name: string;
  /** argv after the command word */
  rest: string[];
  /** Print the message to standard error and exit 2. Readonly property syntax, so TypeScript treats the call as never returning. */
  readonly usageError: (message: string) => never;
}

/** Resolves to the exit code. */
export type Command = (ctx: Ctx) => Promise<number>;
