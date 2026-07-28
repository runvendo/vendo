import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createScrubber, defaultExec, firstLine, type ExecFn } from "./exec.js";

/**
 * The vendo-demos checkout every stage reads and writes through.
 *
 * vendo-demos is PRIVATE and is the only repo prospect branding may land in.
 * The pipeline keeps a long-lived clone (default `~/.vendo/vendo-demos`) rather
 * than a fresh temp clone per run: the host lives in the same repo, so a warm
 * checkout is also a warm `node_modules` and a `next build` that takes minutes
 * instead of tens of them.
 */

export const demosRepoRemote = "https://github.com/runvendo/vendo-demos.git";

/** Contract default: ~/.vendo/vendo-demos. `env` is a seam so the default is
 * testable without reading the real home directory. */
export function defaultDemosRepo(env?: NodeJS.ProcessEnv): string {
  const home = (env ?? process.env).HOME ?? homedir();
  return path.join(home, ".vendo", "vendo-demos");
}

export interface DemosRepoIo {
  exec?: ExecFn;
  write?: (line: string) => void;
  signal?: AbortSignal;
  /** Only the scrubber reads it: git's failures are relayed verbatim. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Clones the host repo when `dir` holds no checkout, otherwise fast-forwards it
 * onto origin/main. Never `reset --hard`: the checkout can hold hand edits to
 * the host or a demo folder, and destroying an operator's work to save one
 * manual `git pull` is not a trade the pipeline gets to make — a pull that
 * cannot fast-forward stops the run and names the fix.
 */
export async function ensureDemosRepo(dir: string, io: DemosRepoIo): Promise<{ dir: string; cloned: boolean; head: string }> {
  const exec = io.exec ?? defaultExec;
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const signal = io.signal;
  // git quotes the remote URL back on a failure, and a push remote can carry a
  // PAT — so every relayed line goes through the scrubber, not just the ones
  // that could hold an env secret.
  const scrub = createScrubber(io.env ?? process.env);
  const run = async (command: string[], cwd: string): Promise<string> => {
    write(`$ ${scrub(command.join(" "))}`);
    const result = await exec(command, { cwd, ...(signal === undefined ? {} : { signal }) });
    if (result.code !== 0) {
      throw new Error(`"${command.join(" ")}" failed in "${cwd}" (exit ${result.code}): ${scrub(firstLine(result.stderr) ?? firstLine(result.stdout) ?? "no output")}`);
    }
    return result.stdout;
  };

  const cloned = !existsSync(path.join(dir, ".git"));
  if (cloned) {
    await mkdir(path.dirname(dir), { recursive: true });
    await run(["git", "clone", demosRepoRemote, dir], path.dirname(dir));
  } else if ((await exec(["git", "remote"], { cwd: dir, ...(signal === undefined ? {} : { signal }) })).stdout.split("\n").map((line) => line.trim()).includes("origin")) {
    const pull = ["git", "pull", "--ff-only", "origin", "main"];
    write(`$ ${pull.join(" ")}`);
    const result = await exec(pull, { cwd: dir, ...(signal === undefined ? {} : { signal }) });
    if (result.code !== 0) {
      throw new Error(
        `The vendo-demos checkout at "${dir}" could not fast-forward onto origin/main `
        + `(${scrub(firstLine(result.stderr) ?? firstLine(result.stdout) ?? `exit ${result.code}`)}). `
        + `It holds local commits or edits the pipeline refuses to discard — resolve it by hand `
        + `(git -C "${dir}" status, then rebase or push) and re-run.`,
      );
    }
  } else {
    // A checkout with no `origin` is not tracking the shared repo at all — an
    // operator-managed or a stand-in checkout passed with --demos-repo. There
    // is nothing to fast-forward onto, and refusing to run would only block
    // the case --demos-repo exists to serve.
    write(`[repo] "${dir}" has no origin remote — using the checkout as it stands (nothing pulled)`);
  }
  const head = (await run(["git", "rev-parse", "HEAD"], dir)).trim();
  return { dir, cloned, head };
}
