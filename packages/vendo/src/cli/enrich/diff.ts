import { execFile } from "node:child_process";

/**
 * Diff computation for the sync AI-enrichment pass (cse lane 1c). The
 * `.vendo/tools.json` watermark is the git TREE hash of the last enrichment;
 * the pass reads `git diff <watermark>` — tree against the WORKING TREE, so
 * committed AND uncommitted edits are included on purpose: sync enriches what
 * is on disk (the extractors scanned the working tree, not HEAD), and a dev
 * mid-change who runs `vendo sync` expects the narrative to describe the code
 * in front of them. Untracked files never appear in the patch; brand-new
 * routes still get enriched because never-enriched tools are always in the
 * affected set (see pass.ts).
 *
 * Anything that prevents an honest incremental diff degrades to FULL mode
 * (re-enrich everything) — never to a silent partial view.
 */

/** Above either limit the diff stops being a focused review and full
 *  re-enrichment is cheaper and more reliable than a runaway prompt:
 *  ~200 KB of patch is roughly a 50k-token context spend, and 150 files
 *  means the change was structural (a rename wave, a formatter run). */
export const DIFF_FILE_LIMIT = 150;
export const DIFF_PATCH_LIMIT_BYTES = 200_000;

export type FullReason = "forced" | "no-watermark" | "not-a-repo" | "watermark-unresolvable" | "oversized";

/** A git object id: 7–64 lowercase hex. The watermark is interpolated as a
 *  git argument BEFORE the `--` separator, so anything that is not a bare
 *  object id (a leading-dash option like `--output=…`, a ref name, a
 *  space-separated pair) must never reach `git` — a hostile or hand-edited
 *  `.vendo/tools.json` watermark would otherwise inject git flags. This runs
 *  on every sync, keyless included, and the corpus harness syncs untrusted
 *  third-party repos, so it is the load-bearing guard, not the schema. */
export const OBJECT_ID = /^[0-9a-f]{7,64}$/;

export type EnrichmentDiff =
  | { mode: "full"; reason: FullReason }
  | { mode: "diff"; files: string[]; patch: string };

type ExecGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

const execGit: ExecGit = (args, cwd) => new Promise((resolve) => {
  execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
    resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout });
  });
});

/** Machine bookkeeping the model must never re-read as "code changes":
 *  `.vendo/` regenerates every sync (committed in some hosts). */
const DIFF_PATHSPEC = [":(exclude).vendo"];

export interface ComputeDiffOptions {
  root: string;
  /** The previous tools.json watermark (tree hash); absent = never enriched. */
  watermark?: string;
  /** --full / init's degenerate case: re-enrich everything. */
  full?: boolean;
  /** Test seam. */
  exec?: ExecGit;
}

export async function computeEnrichmentDiff(options: ComputeDiffOptions): Promise<EnrichmentDiff> {
  if (options.full === true) return { mode: "full", reason: "forced" };
  if (options.watermark === undefined) return { mode: "full", reason: "no-watermark" };
  // Reject a non-object-id watermark BEFORE any git call (argument-injection
  // guard — see OBJECT_ID). A tampered watermark degrades to full mode, which
  // re-enriches everything and cannot mislead an incremental diff anyway.
  if (!OBJECT_ID.test(options.watermark)) return { mode: "full", reason: "watermark-unresolvable" };
  const exec = options.exec ?? execGit;

  const inside = await exec(["rev-parse", "--is-inside-work-tree"], options.root);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return { mode: "full", reason: "not-a-repo" };

  const names = await exec(["diff", "--name-only", options.watermark, "--", ".", ...DIFF_PATHSPEC], options.root);
  if (names.code !== 0) {
    // The watermark tree is unknown to this repo (rewritten history, a GC'd
    // object, a copied .vendo dir) — an incremental diff would lie.
    return { mode: "full", reason: "watermark-unresolvable" };
  }
  const files = names.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (files.length > DIFF_FILE_LIMIT) return { mode: "full", reason: "oversized" };
  if (files.length === 0) return { mode: "diff", files: [], patch: "" };

  const patch = await exec(["diff", options.watermark, "--", ".", ...DIFF_PATHSPEC], options.root);
  if (patch.code !== 0) return { mode: "full", reason: "watermark-unresolvable" };
  if (Buffer.byteLength(patch.stdout, "utf8") > DIFF_PATCH_LIMIT_BYTES) return { mode: "full", reason: "oversized" };
  return { mode: "diff", files, patch: patch.stdout };
}
