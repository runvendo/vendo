import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The repo's committed tree hash (`git rev-parse HEAD^{tree}`) — the
 * `.vendo/tools.json` (vendo/tools@3) `watermark`. Returns undefined when git
 * is unavailable, the root is not inside a work tree, or there is no commit
 * yet: the field is omitted cleanly, never guessed. Content-addressed on
 * purpose — no timestamps, so the same tree always writes the same bytes.
 */
export async function gitTreeHash(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: root });
    const hash = stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(hash) ? hash : undefined;
  } catch {
    return undefined;
  }
}
