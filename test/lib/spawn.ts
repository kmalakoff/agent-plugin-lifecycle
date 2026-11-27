import spawn from 'cross-spawn-cb';

/** What a command printed and exited with; a non-zero exit is a result here, not an error. */
export interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}
/** Runs a command to its end with standard input closed (never a terminal), in `cwd`, with exactly `env`. */
export function runCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Result {
  try {
    const { status, stdout, stderr } = spawn.sync(command, args, { cwd, env, encoding: 'utf8', input: '' });
    return { status, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    // cross-spawn-cb's sync form throws on a non-zero exit; the error carries the result
    const failed = error as { status?: number | null; stdout?: string; stderr?: string; signal?: string | null };
    if (typeof failed.status !== 'number' || failed.signal) throw error;
    return { status: failed.status, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}
