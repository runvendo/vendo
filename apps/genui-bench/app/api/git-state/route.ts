import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { appDir } from "../paths";

export const dynamic = "force-dynamic";

/** GET → {sha, dirtyFiles, lastTouched?} — the git state the NEXT run will
 *  use (the cockpit runs the live working tree). dirtyFiles comes from
 *  `git status --porcelain`; lastTouched is the most recently modified dirty
 *  file, so "what did I just edit" is always visible in the top bar. */
export async function GET(): Promise<Response> {
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { encoding: "utf8", cwd: appDir });
    const sha = git("rev-parse", "HEAD").trim();
    const root = git("rev-parse", "--show-toplevel").trim();
    const porcelain = git("status", "--porcelain").trimEnd();
    const dirtyFiles = porcelain
      ? porcelain.split("\n").map((line) => {
          const path = line.slice(3);
          // Renames read "old -> new"; the new path is the live one.
          const arrow = path.indexOf(" -> ");
          return arrow === -1 ? path : path.slice(arrow + 4);
        })
      : [];

    let lastTouched: { file: string; modifiedAgoMs: number } | undefined;
    let newest = 0;
    for (const file of dirtyFiles.slice(0, 200)) {
      try {
        const mtime = statSync(join(root, file)).mtimeMs;
        if (mtime > newest) {
          newest = mtime;
          lastTouched = { file, modifiedAgoMs: Math.max(0, Date.now() - mtime) };
        }
      } catch {
        // Deleted files have no mtime.
      }
    }
    return Response.json({ sha, dirtyFiles, ...(lastTouched ? { lastTouched } : {}) });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
  }
}
