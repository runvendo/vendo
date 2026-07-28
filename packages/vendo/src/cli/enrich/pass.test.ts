import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtractedTool } from "@vendoai/actions";
import type { ExtractionHarness } from "../extract/harness.js";
import { computeEnrichmentDiff } from "./diff.js";
import { applyDraftEnrichment, readPreviousToolsState, runSyncEnrichment, type SyncEnrichmentOptions } from "./pass.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const tool = (name: string, overrides: Partial<ExtractedTool> = {}): ExtractedTool => ({
  name,
  description: `Use this to call ${name}.`,
  inputSchema: { type: "object", properties: {} },
  risk: "read",
  binding: { kind: "route", method: "GET", path: `/api/${name.replace("host_", "")}`, argsIn: "query" },
  srcHash: `sha256:${name}`,
  ...overrides,
});

async function host(tools: ExtractedTool[], extra: Record<string, unknown> = {}): Promise<{ root: string; vendoDir: string; toolsPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "vendo-enrich-pass-"));
  temporary.push(root);
  const vendoDir = join(root, ".vendo");
  await mkdir(vendoDir, { recursive: true });
  const toolsPath = join(vendoDir, "tools.json");
  await writeFile(toolsPath, `${JSON.stringify({ format: "vendo/tools@3", tools, ...extra }, null, 2)}\n`, "utf8");
  return { root, vendoDir, toolsPath };
}

function output(): { note: (line: string) => void; warn: (line: string) => void; notes: string[]; warns: string[] } {
  const notes: string[] = [];
  const warns: string[] = [];
  return { note: (line) => notes.push(line), warn: (line) => warns.push(line), notes, warns };
}

const reply = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

function scripted(responses: string[]): ExtractionHarness {
  return {
    id: "scripted",
    availability: async () => "scripted engine",
    async run() {
      const next = responses.shift();
      if (next === undefined) throw new Error("scripted harness exhausted");
      return next;
    },
  };
}

const neverHarness: ExtractionHarness = {
  id: "never",
  availability: async () => "never",
  run: async () => { throw new Error("the model must not be called here"); },
};

/** Keyless proof-harness: ANY invocation — even the availability probe —
 *  fails the test outright, so "no model call" is enforced, not inferred. */
const forbiddenHarness: ExtractionHarness = {
  id: "forbidden",
  availability: async () => { throw new Error("keyless sync must never probe an engine"); },
  run: async () => { throw new Error("keyless sync must never invoke a model"); },
};

function baseOptions(
  fixture: { root: string; vendoDir: string },
  channel: ReturnType<typeof output>,
  partial: Partial<SyncEnrichmentOptions> = {},
): SyncEnrichmentOptions {
  return {
    root: fixture.root,
    vendoDir: fixture.vendoDir,
    env: {},
    note: channel.note,
    warn: channel.warn,
    previous: null,
    treeHash: async () => "feedfacefeedfacefeedfacefeedfacefeedface",
    ...partial,
  };
}

describe("readPreviousToolsState", () => {
  it("captures watermark, srcHashes, and enriched markers; tolerates absence and junk", async () => {
    const fixture = await host(
      [tool("host_a", { enriched: true }), tool("host_b")],
      { watermark: "0123456789abcdef0123456789abcdef01234567" },
    );
    const state = await readPreviousToolsState(fixture.vendoDir);
    expect(state?.watermark).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(state?.srcHashes.get("host_a")).toBe("sha256:host_a");
    expect(state?.enriched.has("host_a")).toBe(true);
    expect(state?.enriched.has("host_b")).toBe(false);

    const empty = await mkdtemp(join(tmpdir(), "vendo-enrich-none-"));
    temporary.push(empty);
    expect(await readPreviousToolsState(empty)).toBeNull();
    await writeFile(join(empty, "tools.json"), "{ nope", "utf8");
    expect(await readPreviousToolsState(empty)).toBeNull();
  });
});

describe("runSyncEnrichment", () => {
  it("keyless: structural-only, one calm line, zero errors, file byte-identical, and NO model touchpoint", async () => {
    const fixture = await host([tool("host_a"), tool("host_b")]);
    const before = await readFile(fixture.toolsPath, "utf8");
    const channel = output();
    const result = await runSyncEnrichment(baseOptions(fixture, channel, {
      resolveCredential: async () => ({ rung: "none" }),
      // any engine invocation (even the availability probe) throws
      harnesses: [forbiddenHarness],
    }));
    expect(result.status).toBe("structural-only");
    expect(channel.notes.join("\n")).toContain("structural-only");
    expect(channel.notes.join("\n")).toContain("2 tools unenriched");
    expect(channel.warns).toEqual([]);
    expect(await readFile(fixture.toolsPath, "utf8")).toBe(before);
    // titles are an AI-written label: the structural pass invents none
    expect(before).not.toContain("title");
  });

  it("keyless but fully enriched and unchanged: says up to date, not structural-only", async () => {
    const fixture = await host(
      [tool("host_a", { enriched: true })],
      { watermark: "0123456789abcdef0123456789abcdef01234567" },
    );
    const before = await readFile(fixture.toolsPath, "utf8");
    const channel = output();
    const result = await runSyncEnrichment(baseOptions(fixture, channel, {
      resolveCredential: async () => ({ rung: "none" }),
      harnesses: [forbiddenHarness],
      previous: {
        watermark: "0123456789abcdef0123456789abcdef01234567",
        srcHashes: new Map([["host_a", "sha256:host_a"]]),
        enriched: new Set(["host_a"]),
      },
      computeDiff: async () => ({ mode: "diff", files: [], patch: "" }),
    }));
    expect(result.status).toBe("up-to-date");
    expect(channel.notes).toEqual(["enrichment: up to date"]);
    expect(channel.notes.join("\n")).not.toContain("structural-only");
    expect(await readFile(fixture.toolsPath, "utf8")).toBe(before);
  });

  it("first-ever enrichment (no previous state) classifies applied tools as NEW in the narrative", async () => {
    const fixture = await host([tool("host_a")]);
    const channel = output();
    const result = await runSyncEnrichment(baseOptions(fixture, channel, {
      harness: scripted([reply({ tools: [{ name: "host_a", description: "First pass." }], narrative: "n" })]),
      previous: null,
    }));
    expect(result.status).toBe("enriched");
    const narrative = channel.notes.join("\n");
    expect(narrative).toContain("new tools (1): host_a");
    expect(narrative).not.toContain("changed tools");
  });

  it("applies, marks, advances the watermark, and prints a sectioned narrative (apply-then-show)", async () => {
    const fixture = await host([tool("host_new"), tool("host_changed", { enriched: true })]);
    const channel = output();
    const result = await runSyncEnrichment(baseOptions(fixture, channel, {
      harness: scripted([reply({
        tools: [
          { name: "host_new", description: "Fresh endpoint.", risk: "write" },
          { name: "host_changed", description: "Changed handler.", risk: "read", disabled: false },
        ],
        narrative: "one new endpoint; one handler now also logs.",
      })]),
      previous: {
        watermark: "0123456789abcdef0123456789abcdef01234567",
        srcHashes: new Map([["host_changed", "sha256:OLD"]]),
        enriched: new Set(["host_changed"]),
      },
      computeDiff: async () => ({ mode: "diff", files: ["app/api/changed/route.ts"], patch: "diff --git a b" }),
    }));
    expect(result.status).toBe("enriched");

    const file = JSON.parse(await readFile(fixture.toolsPath, "utf8"));
    expect(file.watermark).toBe("feedfacefeedfacefeedfacefeedfacefeedface");
    const byName = new Map<string, any>(file.tools.map((entry: any) => [entry.name, entry]));
    expect(byName.get("host_new")).toMatchObject({ description: "Fresh endpoint.", risk: "write", enriched: true });
    expect(byName.get("host_changed")).toMatchObject({ description: "Changed handler.", enriched: true });

    const narrative = channel.notes.join("\n");
    expect(narrative).toContain("new tools (1): host_new");
    expect(narrative).toContain("changed tools (1): host_changed");
    expect(narrative).toContain("one handler now also logs");
  });

  it("strips terminal control chars from the model-originated narrative (anti-spoof)", async () => {
    const fixture = await host([tool("host_a")]);
    const channel = output();
    const ESC = String.fromCharCode(0x1b);
    const BEL = String.fromCharCode(0x07);
    const NUL = String.fromCharCode(0x00);
    // an escape-laden narrative a hostile repo could steer the model into:
    // ANSI erase + cursor-up, an OSC title write, a bell, a NUL.
    const evil = `safe line${ESC}[2K${ESC}[1Areal-looking spoof${BEL}${ESC}]0;PWNED${BEL}${NUL}done`;
    const result = await runSyncEnrichment(baseOptions(fixture, channel, {
      harness: scripted([reply({
        tools: [{ name: "host_a", description: "Fine." }],
        narrative: evil,
      })]),
      previous: null,
    }));
    expect(result.status).toBe("enriched");
    const joined = channel.notes.join("\n");
    // no ESC / BEL / NUL / other C0/C1 survive to the terminal
    // eslint-disable-next-line no-control-regex -- asserting control chars are gone
    expect(joined).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    // the visible text is preserved, only the control bytes removed
    expect(joined).toContain("safe line[2K[1Areal-looking spoof]0;PWNEDdone");
  });

  it("counts clamp restrictions in the narrative", async () => {
    const fixture = await host([tool("host_locked", { risk: "destructive", disabled: true, enriched: true })]);
    const channel = output();
    const result = await runSyncEnrichment(baseOptions(fixture, channel, {
      harness: scripted([reply({
        tools: [{ name: "host_locked", risk: "read", disabled: false }],
        narrative: "loosen it all",
      })]),
      previous: {
        watermark: "0123456789abcdef0123456789abcdef01234567",
        srcHashes: new Map([["host_locked", "sha256:OLD"]]),
        enriched: new Set(["host_locked"]),
      },
      computeDiff: async () => ({ mode: "diff", files: ["x.ts"], patch: "d" }),
    }));
    expect(result.status).toBe("enriched");
    const narrative = channel.notes.join("\n");
    expect(narrative).toContain("restricted by clamp (1)");
    expect(narrative).toContain("host_locked");
    const file = JSON.parse(await readFile(fixture.toolsPath, "utf8"));
    expect(file.tools[0]).toMatchObject({ risk: "destructive", disabled: true });
  });

  it("up to date: empty diff and no backlog → no model call, file untouched", async () => {
    const fixture = await host(
      [tool("host_a", { enriched: true })],
      { watermark: "0123456789abcdef0123456789abcdef01234567" },
    );
    const before = await readFile(fixture.toolsPath, "utf8");
    const channel = output();
    const result = await runSyncEnrichment(baseOptions(fixture, channel, {
      harness: neverHarness,
      previous: {
        watermark: "0123456789abcdef0123456789abcdef01234567",
        srcHashes: new Map([["host_a", "sha256:host_a"]]),
        enriched: new Set(["host_a"]),
      },
      computeDiff: async () => ({ mode: "diff", files: [], patch: "" }),
    }));
    expect(result.status).toBe("up-to-date");
    expect(await readFile(fixture.toolsPath, "utf8")).toBe(before);
  });

  it("--review prints the narrative and declining keeps the structural file and old watermark", async () => {
    const fixture = await host(
      [tool("host_a")],
      { watermark: "0123456789abcdef0123456789abcdef01234567" },
    );
    const before = await readFile(fixture.toolsPath, "utf8");
    const channel = output();
    const confirm = vi.fn(async () => false);
    const result = await runSyncEnrichment(baseOptions(fixture, channel, {
      harness: scripted([reply({ tools: [{ name: "host_a", description: "Nicer." }], narrative: "n" })]),
      review: true,
      confirm,
      previous: { watermark: "0123456789abcdef0123456789abcdef01234567", srcHashes: new Map(), enriched: new Set() },
      computeDiff: async () => ({ mode: "diff", files: ["a.ts"], patch: "d" }),
    }));
    expect(result.status).toBe("declined");
    expect(confirm).toHaveBeenCalledOnce();
    // narrative shown before the decision (host_a is new to the previous state)
    expect(channel.notes.join("\n")).toContain("new tools (1): host_a");
    expect(await readFile(fixture.toolsPath, "utf8")).toBe(before);
  });

  it("--full forces full re-enrichment through the diff seam", async () => {
    const fixture = await host([tool("host_a", { enriched: true })]);
    const channel = output();
    const computeDiff = vi.fn(computeEnrichmentDiff);
    await runSyncEnrichment(baseOptions(fixture, channel, {
      harness: scripted([reply({ tools: [], narrative: "nothing" })]),
      full: true,
      previous: { watermark: "w", srcHashes: new Map(), enriched: new Set(["host_a"]) },
      computeDiff,
    }));
    expect(computeDiff).toHaveBeenCalledWith(expect.objectContaining({ full: true }));
  });

  it("unparseable model output warns, skips, and never corrupts the file", async () => {
    const fixture = await host([tool("host_a")]);
    const before = await readFile(fixture.toolsPath, "utf8");
    const channel = output();
    const result = await runSyncEnrichment(baseOptions(fixture, channel, {
      harness: scripted(["no json here at all"]),
    }));
    expect(result.status).toBe("skipped");
    expect(channel.warns.join("\n")).toContain("enrichment");
    expect(await readFile(fixture.toolsPath, "utf8")).toBe(before);
  });

  it("cache stability: a second run with no changes is up to date and byte-identical", async () => {
    const fixture = await host([tool("host_a")]);
    const channel = output();
    const treeHash = async () => "feedfacefeedfacefeedfacefeedfacefeedface";
    const first = await runSyncEnrichment(baseOptions(fixture, channel, {
      harness: scripted([reply({ tools: [{ name: "host_a", description: "Enriched." }], narrative: "n" })]),
      treeHash,
    }));
    expect(first.status).toBe("enriched");
    const bytes = await readFile(fixture.toolsPath, "utf8");

    const second = await runSyncEnrichment(baseOptions(fixture, channel, {
      harness: neverHarness,
      previous: await readPreviousToolsState(fixture.vendoDir).then((state) => state!),
      computeDiff: async () => ({ mode: "diff", files: [], patch: "" }),
      treeHash,
    }));
    expect(second.status).toBe("up-to-date");
    expect(await readFile(fixture.toolsPath, "utf8")).toBe(bytes);
  });

  it("skips silently when tools.json is missing (structural sync failed soft)", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-enrich-missing-"));
    temporary.push(root);
    const channel = output();
    const result = await runSyncEnrichment(baseOptions({ root, vendoDir: join(root, ".vendo") }, channel, {
      harness: neverHarness,
    }));
    expect(result.status).toBe("skipped");
    expect(channel.notes).toEqual([]);
    expect(channel.warns).toEqual([]);
  });
});

describe("applyDraftEnrichment (init's degenerate full-repo pass)", () => {
  it("applies a staged draft through the same clamp, marks enrichment, and sets the watermark", async () => {
    const fixture = await host([
      tool("host_a"),
      tool("host_sleeper", { risk: "destructive", disabled: true }),
      tool("host_admin"),
    ]);
    const summary = await applyDraftEnrichment({
      root: fixture.root,
      vendoDir: fixture.vendoDir,
      draft: {
        brief: "irrelevant here",
        tools: [
          { name: "host_a", description: "Real description.", risk: "write" },
          // a wake attempt: restrictive-only refuses; classification still lands
          { name: "host_sleeper", description: "Actually a safe read.", risk: "read", disabled: false, reasoning: "read-only" },
          { name: "host_admin", description: "Ops console.", audience: "operator" },
          { name: "host_ghost", description: "not real" },
        ],
      },
      treeHash: async () => "feedfacefeedfacefeedfacefeedfacefeedface",
    });

    const file = JSON.parse(await readFile(fixture.toolsPath, "utf8"));
    expect(file.watermark).toBe("feedfacefeedfacefeedfacefeedfacefeedface");
    const byName = new Map<string, any>(file.tools.map((entry: any) => [entry.name, entry]));
    expect(byName.get("host_a")).toMatchObject({ description: "Real description.", risk: "write", enriched: true });
    expect(byName.get("host_sleeper")).toMatchObject({ description: "Actually a safe read.", risk: "destructive", disabled: true, enriched: true });
    expect(byName.get("host_admin")).toMatchObject({ audience: "operator", disabled: true, enriched: true });
    expect(summary.applied).toBe(3);
    expect(summary.clamped.length).toBeGreaterThanOrEqual(1);
    expect(summary.notes.join("\n")).toContain("host_ghost");
    expect(summary.enabledAfter).toBe(1);
  });
});
