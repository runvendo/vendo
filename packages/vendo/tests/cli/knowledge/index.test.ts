import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { knowledgeHashManifestSchema, type KnowledgeAdapter, type KnowledgeDoc } from "@vendoai/core";
import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import { httpKnowledge } from "@vendoai/knowledge";
import { runKnowledge } from "../../../src/cli/knowledge/index.js";
import type { Output } from "../../../src/cli/shared.js";

// `vendo knowledge` (ENG-362): add/list/remove edit .vendo/knowledge.json;
// sync ingests, diffs against the sha256 manifest, and pushes DOCUMENT-level
// upserts/removes to the engine, rewriting the manifest last.

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vendo-knowledge-cli-"));
  dirs.push(dir);
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs", "guide.md"), "# Guide\nRefunds take 5 days.\n");
  await writeFile(join(dir, "docs", "faq.md"), "# FAQ\nAnswers live here.\n");
  return dir;
}

function capture(): { output: Output; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { output: { log: (m) => lines.push(m), error: (m) => errors.push(m) }, lines, errors };
}

/** memoryKnowledgeAdapter with spied upsert/remove, wrapped so posture and
    optional-member presence stay contract-true. */
function spiedAdapter(): { adapter: KnowledgeAdapter; upsert: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
  const inner = memoryKnowledgeAdapter();
  const upsert = vi.fn(async (docs: KnowledgeDoc[]) => inner.upsert!(docs));
  const remove = vi.fn(async (ids: string[]) => inner.remove!(ids));
  return { adapter: { ...inner, upsert, remove }, upsert, remove };
}

describe("vendo knowledge — option validation (ENG-335)", () => {
  it("fails loudly on unknown flags before anything runs", async () => {
    const dir = await tempProject();
    const cap = capture();
    expect(await runKnowledge(["sync", dir, "--frce"], { output: cap.output })).toBe(1);
    expect(cap.errors.join("\n")).toContain("unknown option: --frce");
    expect(await runKnowledge(["add", "docs/**", dir, "--kind"], { output: cap.output })).toBe(1);
    expect(cap.errors.join("\n")).toContain("--kind requires a value");
    expect(await runKnowledge(["add", "docs/**", dir, "--kind", "prose"], { output: cap.output })).toBe(1);
    expect(cap.errors.join("\n")).toContain("--kind must be one of docs, glossary, api");
  });

  it("refuses root-escaping and absolute source globs at add time (checker round 1 fix 1)", async () => {
    const dir = await tempProject();
    const cap = capture();
    expect(await runKnowledge(["add", "../outside/*.md", dir], { output: cap.output })).toBe(1);
    expect(await runKnowledge(["add", "/etc/*.conf", dir], { output: cap.output })).toBe(1);
    expect(cap.errors.join("\n")).toContain("project root");
    await expect(readFile(join(dir, ".vendo", "knowledge.json"), "utf8")).rejects.toThrow();
  });
});

describe("vendo knowledge add/list/remove", () => {
  it("round-trips a source entry on a temp dir", async () => {
    const dir = await tempProject();
    const cap = capture();
    expect(await runKnowledge(["add", "docs/**/*.md", dir, "--kind", "docs"], { output: cap.output })).toBe(0);
    const written = JSON.parse(await readFile(join(dir, ".vendo", "knowledge.json"), "utf8"));
    expect(written).toEqual({
      format: "vendo/knowledge@1",
      sources: [{ name: "docs", glob: "docs/**/*.md", kind: "docs", visibility: "public" }],
    });

    expect(await runKnowledge(["list", dir], { output: cap.output })).toBe(0);
    expect(cap.lines.join("\n")).toMatch(/docs\s+docs\/\*\*\/\*\.md\s+docs\s+public/);

    expect(await runKnowledge(["add", "docs/**/*.md", dir], { output: cap.output })).toBe(1);
    expect(cap.errors.join("\n")).toContain("already exists");

    expect(await runKnowledge(["remove", "docs", dir], { output: cap.output })).toBe(0);
    const after = JSON.parse(await readFile(join(dir, ".vendo", "knowledge.json"), "utf8"));
    expect(after.sources).toEqual([]);

    expect(await runKnowledge(["remove", "docs", dir], { output: cap.output })).toBe(1);
    expect(cap.errors.join("\n")).toContain("no source named");
  });

  it("points notion/gdocs at the console sources page instead of pretending to sync them", async () => {
    const cap = capture();
    expect(await runKnowledge(["add", "notion"], { output: cap.output })).toBe(0);
    expect(cap.lines.join("\n")).toContain("console.vendo.run/knowledge/sources?connect=notion");
  });
});

describe("vendo knowledge sync", () => {
  it("first run upserts all; no-change run upserts none; an edit re-upserts exactly that doc; a delete removes", async () => {
    const dir = await tempProject();
    const cap = capture();
    await runKnowledge(["add", "docs/**/*.md", dir], { output: cap.output });

    const { adapter, upsert, remove } = spiedAdapter();
    expect(await runKnowledge(["sync", dir], { output: cap.output, adapter })).toBe(0);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect((upsert.mock.calls[0]![0] as KnowledgeDoc[]).map((doc) => doc.id).sort()).toEqual([
      "docs#docs/faq.md",
      "docs#docs/guide.md",
    ]);
    expect(remove).not.toHaveBeenCalled();

    const manifest = knowledgeHashManifestSchema.parse(
      JSON.parse(await readFile(join(dir, ".vendo", "knowledge-manifest.json"), "utf8")),
    );
    expect(Object.keys(manifest.docs).sort()).toEqual(["docs#docs/faq.md", "docs#docs/guide.md"]);

    upsert.mockClear();
    expect(await runKnowledge(["sync", dir], { output: cap.output, adapter })).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();

    await writeFile(join(dir, "docs", "guide.md"), "# Guide\nRefunds now take 3 days.\n");
    expect(await runKnowledge(["sync", dir], { output: cap.output, adapter })).toBe(0);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect((upsert.mock.calls[0]![0] as KnowledgeDoc[]).map((doc) => doc.id)).toEqual(["docs#docs/guide.md"]);

    upsert.mockClear();
    await rm(join(dir, "docs", "faq.md"));
    expect(await runKnowledge(["sync", dir], { output: cap.output, adapter })).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(["docs#docs/faq.md"]);
  });

  it("--dry-run prints the plan without touching the engine or the manifest", async () => {
    const dir = await tempProject();
    const cap = capture();
    await runKnowledge(["add", "docs/**/*.md", dir], { output: cap.output });
    const { adapter, upsert, remove } = spiedAdapter();
    expect(await runKnowledge(["sync", dir, "--dry-run"], { output: cap.output, adapter })).toBe(0);
    expect(cap.lines.join("\n")).toContain("2 to upsert");
    expect(upsert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    await expect(readFile(join(dir, ".vendo", "knowledge-manifest.json"), "utf8")).rejects.toThrow();
  });

  it("refuses loudly to push to a read-only httpKnowledge engine and leaves the manifest unwritten (ENG-365)", async () => {
    const dir = await tempProject();
    const cap = capture();
    await runKnowledge(["add", "docs/**/*.md", dir], { output: cap.output });
    // The BYO default posture is read-only search-only; sync must refuse
    // BEFORE any network call — no fetch is even wired here.
    const readOnly = httpKnowledge({ url: "https://byo.example/knowledge" });
    expect(await runKnowledge(["sync", dir], { output: cap.output, adapter: readOnly })).toBe(1);
    expect(cap.errors.join("\n")).toContain("read-only");
    await expect(readFile(join(dir, ".vendo", "knowledge-manifest.json"), "utf8")).rejects.toThrow();
  });

  it("fails with guidance when no config exists and when the manifest is corrupt", async () => {
    const dir = await tempProject();
    const cap = capture();
    expect(await runKnowledge(["sync", dir], { output: cap.output })).toBe(1);
    expect(cap.errors.join("\n")).toContain("no .vendo/knowledge.json");

    await runKnowledge(["add", "docs/**/*.md", dir], { output: cap.output });
    await mkdir(join(dir, ".vendo"), { recursive: true });
    await writeFile(join(dir, ".vendo", "knowledge-manifest.json"), '{"format":"wrong"}', "utf8");
    expect(await runKnowledge(["sync", dir], { output: cap.output, adapter: spiedAdapter().adapter })).toBe(1);
    expect(cap.errors.join("\n")).toContain("delete it to re-sync");
  });
});
