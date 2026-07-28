import { spawn } from "node:child_process";
import { Transform } from "node:stream";

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

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Credentials embedded in a URL, e.g. a push remote's
 * `https://x-access-token:ghp_…@github.com/…`. Git quotes its own remote back on
 * a failure, and that token is in .git/config — never in the environment — so no
 * env-name rule can catch it.
 *
 * The password half is OPTIONAL: `https://ghp_…@github.com/…` (token-only
 * userinfo, what `gh auth setup-git` and most CI remotes produce) has no colon at
 * all, and the old `user:pass@` rule let it through verbatim.
 */
const urlCredentials = /:\/\/[^\s/@:]+(?::[^\s/@]*)?@/g;

/**
 * Redacts everything credential-shaped from text that came out of a child
 * process. Children echo their environment on some failures and git echoes its
 * remote, and every relayed line ends up in an operator's terminal or a Slack
 * thread — so nothing reaches a `write` or an `Error` unscrubbed.
 *
 * Only values over 8 characters count: redacting `NODE_ENV=production` or a
 * short flag value would make the failure it is attached to unreadable, which
 * is the other way to lose a run.
 */
export function createScrubber(env: NodeJS.ProcessEnv): (text: string) => string {
  const secrets = Object.entries(env)
    .filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD/.test(name) && typeof value === "string" && value.length > 8)
    .map(([, value]) => value as string);
  return (text: string): string =>
    secrets.reduce((scrubbed, secret) => scrubbed.replaceAll(secret, "<redacted>"), text)
      .replace(urlCredentials, "://<redacted>@");
}

/**
 * The same scrubber, as a stream — for child output that goes to a FILE rather
 * than through a `write`.
 *
 * The local host boot spawns Next with the operator's whole environment and pipes
 * its stdout and stderr into a log file; a crash that echoes the environment wrote
 * VENDO_API_KEY to disk in plaintext. Line-buffered so a secret split across two
 * chunks is still redacted.
 */
export function scrubbingTransform(scrub: (text: string) => string): Transform {
  let held = "";
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      held += chunk.toString();
      const lastBreak = held.lastIndexOf("\n");
      if (lastBreak !== -1) {
        const ready = held.slice(0, lastBreak + 1);
        held = held.slice(lastBreak + 1);
        this.push(scrub(ready));
      }
      callback();
    },
    flush(callback) {
      if (held !== "") this.push(scrub(held));
      held = "";
      callback();
    },
  });
}
