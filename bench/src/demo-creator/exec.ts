import { spawn } from "node:child_process";

/**
 * Child-process plumbing shared by every pipeline stage that shells out
 * (`vendo sync`, the host build, git, `railway up`).
 *
 * argv array, never a command string: secrets, slugs and prospect names are
 * arguments, so no shell quoting layer can ever see them.
 */

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (command: string[], options: { cwd: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;

/**
 * Cancellation: children run in their own process group, and an aborted
 * `signal` SIGKILLs the whole group — the pipeline's wall-clock cap must
 * TERMINATE in-flight work (a `railway up` completing after the cap fired
 * would be a deploy nobody is watching), not merely stop awaiting it.
 */
export const defaultExec: ExecFn = (command, options) =>
  new Promise((resolve, reject) => {
    const [file, ...args] = command;
    if (file === undefined) {
      reject(new Error("empty command"));
      return;
    }
    if (options.signal?.aborted) {
      reject(options.signal.reason instanceof Error ? options.signal.reason : new Error("exec aborted before start"));
      return;
    }
    const child = spawn(file, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    const killGroup = (): void => {
      if (child.exitCode !== null || child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    options.signal?.addEventListener("abort", killGroup, { once: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", killGroup);
      reject(error);
    });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", killGroup);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

/** First non-blank line of a child's output — for one-line failure causes. */
export function firstLine(text: string): string | undefined {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
  return line?.trim();
}
