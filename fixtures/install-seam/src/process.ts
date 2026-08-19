import { spawn } from "node:child_process";
import { createServer } from "node:net";

export interface CommandResult {
  code: number | null;
  output: string;
}

/** Runs a command to completion, capturing merged stdout/stderr. */
export function run(
  command: string,
  args: readonly string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

/** Throws with the captured output on a non-zero exit — the failure message a
 *  reader can act on, instead of a bare exit code. */
export async function checked(step: string, result: Promise<CommandResult>): Promise<CommandResult> {
  const settled = await result;
  if (settled.code !== 0) {
    throw new Error(`${step} exited ${settled.code}:\n${settled.output.slice(-6000)}`);
  }
  return settled;
}

/** The fixture-suite port rule: let the OS name a free one, then hand the
 *  number to the child. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("could not reserve a port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
