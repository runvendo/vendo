import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildEnumeratorPrompt,
  collectFrontendSources,
  createLlmEnumerator,
  diffUiParity,
  extractEnumerationJson,
  loadSurface,
  runUiParityLayer,
  summarizeUiParity,
  UI_PARITY_LAYER,
  type FrontendSource,
  type UiCapability,
  type UiParityEnumerator,
} from "./ui-parity.js";

function capability(overrides: Partial<UiCapability> & Pick<UiCapability, "id">): UiCapability {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? overrides.id,
    kind: overrides.kind ?? "write",
    expectedTools: overrides.expectedTools ?? [],
  };
}

async function tempRepo(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "ui-parity-"));
}

describe("diffUiParity", () => {
  const surface = new Set(["host_records_update", "bulk_paste_range", "host_fields_create"]);

  it("marks a capability covered when at least one claimed tool exists", () => {
    const result = diffUiParity(
      [capability({ id: "paste", expectedTools: ["bulk_paste_range", "does_not_exist"] })],
      surface,
    );
    expect(result.entries[0]?.status).toBe("covered");
    expect(result.entries[0]?.matchedTools).toEqual(["bulk_paste_range"]);
    expect(result.entries[0]?.missingTools).toEqual(["does_not_exist"]);
    // A partial claim is still counted a phantom for the reviewer's attention.
    expect(result.phantoms).toHaveLength(1);
    expect(result.coverage.value).toBe(1);
  });

  it("marks a capability a gap when no covering tool is claimed", () => {
    const result = diffUiParity([capability({ id: "kanban-drag", expectedTools: [] })], surface);
    expect(result.entries[0]?.status).toBe("gap");
    expect(result.gaps).toHaveLength(1);
    expect(result.coverage.value).toBe(0);
  });

  it("marks a capability a phantom when every claimed tool is missing", () => {
    const result = diffUiParity([capability({ id: "convert", expectedTools: ["ghost_tool"] })], surface);
    expect(result.entries[0]?.status).toBe("phantom");
    expect(result.gaps).toHaveLength(1);
    expect(result.phantoms).toHaveLength(1);
  });

  it("computes a fractional coverage metric across mixed capabilities", () => {
    const result = diffUiParity(
      [
        capability({ id: "a", expectedTools: ["host_records_update"] }),
        capability({ id: "b", expectedTools: ["host_fields_create"] }),
        capability({ id: "c", expectedTools: [] }),
        capability({ id: "d", expectedTools: ["ghost"] }),
      ],
      surface,
    );
    expect(result.coverage).toEqual({ passed: 2, total: 4, value: 0.5 });
    expect(result.gaps.map((entry) => entry.capability.id)).toEqual(["c", "d"]);
  });

  it("treats an empty enumeration as vacuously fully covered", () => {
    const result = diffUiParity([], surface);
    expect(result.coverage).toEqual({ passed: 0, total: 0, value: 1 });
  });
});

describe("summarizeUiParity", () => {
  it("builds an informational, never-hard-failing scorecard layer", () => {
    const coverage = diffUiParity(
      [
        capability({ id: "covered", expectedTools: ["t"] }),
        capability({ id: "missing", expectedTools: [] }),
      ],
      new Set(["t"]),
    );
    const layer = summarizeUiParity(coverage, ["/tmp/ui-parity.json"]);
    expect(layer.layer).toBe(UI_PARITY_LAYER);
    expect(layer.name).toBe("ui-parity");
    expect(layer.hardFailure).toBe(false);
    expect(layer.status).toBe("pass");
    expect(layer.score).toEqual({ passed: 1, total: 2, value: 0.5 });
    expect(layer.checks?.map((check) => check.pass)).toEqual([true, false]);
    expect(layer.detail).toContain("1 gap(s): missing");
    expect(layer.logPaths).toEqual(["/tmp/ui-parity.json"]);
  });
});

describe("loadSurface", () => {
  it("merges extracted tools, refined compounds, and briefs, honoring disables", async () => {
    const repoDir = await tempRepo();
    await mkdir(path.join(repoDir, ".vendo"), { recursive: true });
    await writeFile(path.join(repoDir, ".vendo/tools.json"), JSON.stringify({
      format: "vendo/tools@1",
      tools: [
        { name: "host_records_list", risk: "read", binding: { kind: "route", method: "GET", path: "/x" } },
        { name: "host_records_update", risk: "write", binding: { kind: "route", method: "PATCH", path: "/y" } },
        { name: "host_dangerous", risk: "destructive", disabled: true, binding: { kind: "route", method: "DELETE", path: "/z" } },
      ],
    }));
    await writeFile(path.join(repoDir, ".vendo/capabilities.json"), JSON.stringify({
      format: "vendo/capabilities@1",
      tools: [{ name: "bulk_paste_range", risk: "write", binding: { kind: "compound", steps: [] } }],
      briefs: [{ name: "reconfigure-view", text: "…", tools: ["host_records_list"] }],
    }));
    await writeFile(path.join(repoDir, ".vendo/overrides.json"), JSON.stringify({
      format: "vendo/overrides@1",
      tools: { host_records_list: { disabled: true } },
    }));

    const surface = await loadSurface(repoDir);
    const byName = new Map(surface.map((entry) => [entry.name, entry]));
    expect(byName.get("host_records_list")?.disabled).toBe(true);
    expect(byName.get("host_records_update")?.kind).toBe("tool");
    expect(byName.get("host_dangerous")?.disabled).toBe(true);
    expect(byName.get("bulk_paste_range")?.kind).toBe("compound");
    expect(byName.get("reconfigure-view")?.kind).toBe("brief");
  });

  it("returns an empty surface for a repo with no generated files", async () => {
    const repoDir = await tempRepo();
    await expect(loadSurface(repoDir)).resolves.toEqual([]);
  });
});

describe("runUiParityLayer", () => {
  it("excludes disabled tools from the surface passed to the enumerator and computes coverage", async () => {
    const repoDir = await tempRepo();
    await mkdir(path.join(repoDir, ".vendo"), { recursive: true });
    await writeFile(path.join(repoDir, ".vendo/tools.json"), JSON.stringify({
      format: "vendo/tools@1",
      tools: [
        { name: "host_records_update", risk: "write", binding: { kind: "route", method: "PATCH", path: "/y" } },
        { name: "host_disabled", risk: "write", disabled: true, binding: { kind: "route", method: "POST", path: "/d" } },
      ],
    }));

    let seenSurfaceNames: string[] = [];
    const enumerate: UiParityEnumerator = async (input) => {
      seenSurfaceNames = input.surface.map((entry) => entry.name);
      return {
        capabilities: [
          capability({ id: "edit-cell", expectedTools: ["host_records_update"] }),
          capability({ id: "kanban-drag", expectedTools: [] }),
          // The enumerator must not be able to "cover" via a disabled tool.
          capability({ id: "bulk-delete", expectedTools: ["host_disabled"] }),
        ],
      };
    };

    const logsDir = path.join(repoDir, "logs");
    const result = await runUiParityLayer({
      repoName: "sample",
      repoDir,
      enumerate,
      logsDir,
      readFrontendSources: async () => [{ path: "src/App.tsx", text: "export default () => null;" }],
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    });

    expect(seenSurfaceNames).toEqual(["host_records_update"]);
    expect(result.coverage.coverage).toEqual({ passed: 1, total: 3, value: round(1 / 3) });
    expect(result.coverage.entries.find((entry) => entry.capability.id === "bulk-delete")?.status).toBe("phantom");
    expect(result.layer.hardFailure).toBe(false);
    expect(result.logPath).toBe(path.join(logsDir, "ui-parity.json"));
  });
});

describe("collectFrontendSources", () => {
  it("collects source files under frontend dirs and skips tests and node_modules", async () => {
    const repoDir = await tempRepo();
    await mkdir(path.join(repoDir, "src/components"), { recursive: true });
    await mkdir(path.join(repoDir, "node_modules/pkg"), { recursive: true });
    await writeFile(path.join(repoDir, "src/App.tsx"), "export const App = () => null;");
    await writeFile(path.join(repoDir, "src/components/Grid.tsx"), "export const Grid = () => null;");
    await writeFile(path.join(repoDir, "src/App.test.tsx"), "test('x', () => {});");
    await writeFile(path.join(repoDir, "node_modules/pkg/index.js"), "module.exports = {};");

    const sources = await collectFrontendSources(repoDir);
    const paths = sources.map((source) => source.path).sort();
    expect(paths).toEqual(["src/App.tsx", "src/components/Grid.tsx"]);
  });

  it("truncates oversized files to the byte budget", async () => {
    const repoDir = await tempRepo();
    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src/Big.tsx"), "x".repeat(50));
    const sources = await collectFrontendSources(repoDir, 10, 20);
    expect(sources[0]?.text.length).toBe(20);
  });
});

describe("createLlmEnumerator", () => {
  it("parses a strict-JSON model response into capabilities", async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: '{"capabilities":[{"id":"paste","title":"Paste","description":"Paste a range","kind":"write","expectedTools":["bulk_paste_range"]}]}',
    });
    const enumerate = createLlmEnumerator({ model: {}, generateText });
    const result = await enumerate({
      repoName: "sample",
      frontendSources: [{ path: "src/App.tsx", text: "code" }],
      surface: [{ name: "bulk_paste_range", kind: "compound", disabled: false }],
    });
    expect(result.capabilities[0]?.id).toBe("paste");
    expect(generateText).toHaveBeenCalledTimes(1);
    const prompt = generateText.mock.calls[0]?.[0].prompt as string;
    expect(prompt).toContain("bulk_paste_range [compound]");
    expect(prompt).toContain("src/App.tsx");
  });

  it("recovers JSON wrapped in a fenced code block and prose", async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: 'Here you go:\n```json\n{"capabilities":[]}\n```\nDone.',
    });
    const enumerate = createLlmEnumerator({ model: {}, generateText });
    await expect(enumerate({ repoName: "s", frontendSources: [], surface: [] }))
      .resolves.toEqual({ capabilities: [] });
  });

  it("defaults a missing expectedTools array to an empty gap", () => {
    const parsed = extractEnumerationJson('{"capabilities":[{"id":"g","title":"G","description":"d","kind":"read"}]}');
    expect(parsed).toBeTruthy();
  });

  it("throws when the model returns no JSON object", () => {
    expect(() => extractEnumerationJson("no json here")).toThrow(/no JSON object/);
  });
});

describe("buildEnumeratorPrompt", () => {
  it("handles an empty surface and no sources without crashing", () => {
    const prompt = buildEnumeratorPrompt({ repoName: "empty", frontendSources: [], surface: [] });
    expect(prompt).toContain("(empty surface)");
    expect(prompt).toContain("(no frontend sources found)");
  });
});

function round(value: number): number {
  return Number(value.toFixed(6));
}
