import { spawn } from 'node:child_process';

/** Runs a command string through the platform shell, as written, in `cwd`; standard input is closed and all its output goes to our standard error. */
export function runScript(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    // our standard output holds only apl's result lines
    const child = spawn(command, { shell: true, cwd, env, stdio: ['ignore', 2, 'inherit'] });
    child.on('error', settle);
    child.on('close', (code, signal) => {
      if (signal) settle(new Error(`killed by ${signal}`));
      else if (code !== 0) settle(new Error(`exit code ${code}`));
      else settle();
    });
  });
}
