import { spawn } from 'node:child_process';

/** What a finished command returned. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kills the command and fails once it has run this long. */
  timeoutMs?: number;
}

/** The command line and its output, for the message of a failed assertion. */
export function describeResult(
  command: string,
  args: readonly string[],
  result: CommandResult,
): string {
  return [
    `${command} ${args.join(' ')} exited with ${String(result.code)}`,
    `stdout:\n${result.stdout.slice(-4000)}`,
    `stderr:\n${result.stderr.slice(-4000)}`,
  ].join('\n');
}

/**
 * Runs `command` without a shell and resolves with its exit code and output, whatever the code.
 * Standard input is closed, so Docker never allocates a terminal.
 */
export async function run(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill('SIGKILL');
            reject(
              new Error(
                `${command} ${args.join(' ')} did not finish within ${String(options.timeoutMs)} ms\n` +
                  Buffer.concat(stderr).toString('utf8').slice(-4000),
              ),
            );
          }, options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? (signal === null ? -1 : 128),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - started,
      });
    });
  });
}

/** Runs `command` and fails with its output unless it exits with code 0. */
export async function runOk(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) throw new Error(describeResult(command, args, result));
  return result;
}
