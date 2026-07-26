import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DIFF_FILE_LIMIT, DIFF_PATCH_LIMIT_BYTES, computeEnrichmentDiff } from "./diff.js";

const run = promisify(execFile);

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function gitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-enrich-diff-"));
  temporary.push(root);
  await run("git", ["init", "-q"], { cwd: root });
  return root;
}

async function write(root: string, relative: string, text: string): Promise<void> {
  const file = join(root, relative);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

async function commit(root: string, message: string): Promise<string> {
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", message], { cwd: root });
  const { stdout } = await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: root });
  return stdout.trim();
}

describe("computeEnrichmentDiff", () => {
  it("diffs from the watermark tree to the working tree, including uncommitted changes", async () => {
    const root = await gitRepo();
    await write(root, "app/api/items/route.ts", "export function GET() {}\n");
    const watermark = await commit(root, "one");
    await write(root, "app/api/items/route.ts", "export function GET() { /* changed */ }\n");
    await commit(root, "two");
    // uncommitted on top — sync enriches what is on disk, so the diff must see it
    await write(root, "lib/shared.ts", "export const fee = 2;\n");
    await run("git", ["add", "lib/shared.ts"], { cwd: root });

    const diff = await computeEnrichmentDiff({ root, watermark });
    expect(diff.mode).toBe("diff");
    if (diff.mode !== "diff") return;
    expect(diff.files).toEqual(["app/api/items/route.ts", "lib/shared.ts"]);
    expect(diff.patch).toContain("/* changed */");
    expect(diff.patch).toContain("export const fee = 2;");
  });

  it("returns an empty diff when the working tree matches the watermark", async () => {
    const root = await gitRepo();
    await write(root, "a.ts", "export {}\n");
    const watermark = await commit(root, "one");
    const diff = await computeEnrichmentDiff({ root, watermark });
    expect(diff).toEqual({ mode: "diff", files: [], patch: "" });
  });

  it("excludes .vendo bookkeeping churn from the patch", async () => {
    const root = await gitRepo();
    await write(root, "a.ts", "export {}\n");
    await write(root, ".vendo/tools.json", "{}\n");
    const watermark = await commit(root, "one");
    await write(root, ".vendo/tools.json", "{ \"format\": \"vendo/tools@3\" }\n");
    const diff = await computeEnrichmentDiff({ root, watermark });
    expect(diff).toEqual({ mode: "diff", files: [], patch: "" });
  });

  it("falls back to full mode: no watermark, forced, outside a repo, unresolvable watermark, oversized diff", async () => {
    const plain = await mkdtemp(join(tmpdir(), "vendo-enrich-plain-"));
    temporary.push(plain);
    expect(await computeEnrichmentDiff({ root: plain })).toEqual({ mode: "full", reason: "no-watermark" });
    expect(await computeEnrichmentDiff({ root: plain, full: true, watermark: "abc" })).toEqual({ mode: "full", reason: "forced" });
    expect(await computeEnrichmentDiff({ root: plain, watermark: "0123456789abcdef0123456789abcdef01234567" }))
      .toEqual({ mode: "full", reason: "not-a-repo" });

    const root = await gitRepo();
    await write(root, "a.ts", "export {}\n");
    const watermark = await commit(root, "one");
    expect(await computeEnrichmentDiff({ root, watermark: "0123456789abcdef0123456789abcdef01234567" }))
      .toEqual({ mode: "full", reason: "watermark-unresolvable" });

    // oversized by file count
    for (let index = 0; index < DIFF_FILE_LIMIT + 1; index += 1) {
      await write(root, `src/file-${index}.ts`, "export {}\n");
    }
    await commit(root, "many");
    expect(await computeEnrichmentDiff({ root, watermark })).toEqual({ mode: "full", reason: "oversized" });
  });

  it("rejects a non-object-id watermark BEFORE any git call — a hostile tools.json cannot inject git arguments", async () => {
    const root = await gitRepo();
    await write(root, "a.ts", "export {}\n");
    await commit(root, "one");

    // The classic: a watermark crafted as a git option. Unvalidated, git
    // would honor --output and truncate/create an arbitrary file.
    const target = join(root, "pwned.txt");
    const diff = await computeEnrichmentDiff({ root, watermark: `--output=${target}` });
    expect(diff).toEqual({ mode: "full", reason: "watermark-unresolvable" });
    await expect(readFile(target, "utf8")).rejects.toThrow(); // never created

    // other non-object-id shapes degrade the same way, without reaching git
    const execGit = async (): Promise<{ code: number; stdout: string }> => {
      throw new Error("git must not be invoked with an invalid watermark");
    };
    for (const watermark of ["-Upwn", "HEAD", "main", "0123ABCDEF", "0123456789abcdef 0123"]) {
      expect(await computeEnrichmentDiff({ root, watermark, exec: execGit }))
        .toEqual({ mode: "full", reason: "watermark-unresolvable" });
    }
  });

  it("falls back to full mode on an oversized patch", async () => {
    const root = await gitRepo();
    await write(root, "a.ts", "export {}\n");
    const watermark = await commit(root, "one");
    await write(root, "big.ts", `export const blob = ${JSON.stringify("x".repeat(DIFF_PATCH_LIMIT_BYTES + 1))};\n`);
    await commit(root, "big");
    expect(await computeEnrichmentDiff({ root, watermark })).toEqual({ mode: "full", reason: "oversized" });
  });
});
