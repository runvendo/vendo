import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultBrand } from "@flowlet/components/theme";
import { loadFlowletDir } from "./flowlet-dir";

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "flowlet-next-"));
}

const THEME = {
  version: 1,
  accent: "#0A7CFF",
  background: "#FBFBFA",
  surface: "#FFFFFF",
  text: "#111111",
  mutedText: "#908C85",
  fontFamily: "system-ui, sans-serif",
  radius: "14px",
  mode: "light",
};

const TOOLS = {
  version: 1,
  tools: [
    {
      name: "list_things",
      description: "List things",
      inputSchema: { type: "object", properties: {} },
      annotations: { mutating: false, dangerous: false },
      binding: { type: "http", method: "GET", path: "/api/things" },
    },
  ],
};

describe("loadFlowletDir", () => {
  it("reads theme.json and tools.json", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".flowlet"));
    writeFileSync(path.join(dir, ".flowlet/theme.json"), JSON.stringify(THEME));
    writeFileSync(path.join(dir, ".flowlet/tools.json"), JSON.stringify(TOOLS));
    const loaded = loadFlowletDir(path.join(dir, ".flowlet"));
    expect(loaded.brand.accent).toBe("#0A7CFF");
    expect(loaded.manifest.tools).toHaveLength(1);
    expect(loaded.manifest.events).toEqual([]);
  });

  it("falls back to the default brand and an empty manifest when .flowlet/ is absent", () => {
    const loaded = loadFlowletDir(path.join(scratch(), ".flowlet"));
    expect(loaded.brand).toEqual(defaultBrand);
    expect(loaded.manifest.tools).toEqual([]);
  });

  it("fails loud on a schema-invalid tools.json (developer-editable file)", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".flowlet"));
    writeFileSync(path.join(dir, ".flowlet/tools.json"), JSON.stringify({ version: 1, tools: [{}] }));
    expect(() => loadFlowletDir(path.join(dir, ".flowlet"))).toThrow(/tools\.json/);
  });

  it("fails loud on invalid JSON in theme.json", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".flowlet"));
    writeFileSync(path.join(dir, ".flowlet/theme.json"), "{nope");
    expect(() => loadFlowletDir(path.join(dir, ".flowlet"))).toThrow(/theme\.json/);
  });

  it("reads flowlet sync artifacts: remix-sources.json + env/manifest.json (absent → defaults)", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".flowlet/env"), { recursive: true });
    writeFileSync(
      path.join(dir, ".flowlet/remix-sources.json"),
      JSON.stringify({
        "upcoming-deadlines": {
          file: "src/components/dashboard/deadline-list.tsx",
          exportName: "DeadlineList",
          source: "export function DeadlineList() {}",
          sourceHash: "h1",
          capturedAt: "2026-07-04T00:00:00.000Z",
        },
      }),
    );
    writeFileSync(
      path.join(dir, ".flowlet/env/manifest.json"),
      JSON.stringify({
        anchors: {
          "upcoming-deadlines": {
            "lucide-react": { kind: "real" },
            swr: { kind: "shimmed", note: "anchor data" },
          },
        },
        vendorSizes: { "lucide-react": 41000 },
      }),
    );
    const loaded = loadFlowletDir(path.join(dir, ".flowlet"));
    expect(loaded.remixSources["upcoming-deadlines"]?.exportName).toBe("DeadlineList");
    expect(loaded.envManifest?.anchors["upcoming-deadlines"]?.["swr"]).toEqual({
      kind: "shimmed",
      note: "anchor data",
    });

    // Absent → defaults, not errors.
    const empty = loadFlowletDir(path.join(scratch(), ".flowlet"));
    expect(empty.remixSources).toEqual({});
    expect(empty.envManifest).toBeUndefined();
  });

  it("fails loud on schema-invalid remix-sources.json and env/manifest.json", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".flowlet"));
    writeFileSync(path.join(dir, ".flowlet/remix-sources.json"), JSON.stringify({ a: { file: "" } }));
    expect(() => loadFlowletDir(path.join(dir, ".flowlet"))).toThrow(/remix-sources\.json/);

    const dir2 = scratch();
    mkdirSync(path.join(dir2, ".flowlet/env"), { recursive: true });
    writeFileSync(path.join(dir2, ".flowlet/env/manifest.json"), JSON.stringify({ anchors: { a: { x: { kind: "??" } } } }));
    expect(() => loadFlowletDir(path.join(dir2, ".flowlet"))).toThrow(/manifest\.json/);
  });

  it("returns undefined mcpServers when mcp.json is absent (zero-config)", () => {
    const loaded = loadFlowletDir(path.join(scratch(), ".flowlet"));
    expect(loaded.mcpServers).toBeUndefined();
  });

  it("loads and validates mcp.json when present", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".flowlet"));
    writeFileSync(
      path.join(dir, ".flowlet/mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [{ name: "weather", url: "https://mcp.example.com/mcp" }],
      }),
    );
    expect(loadFlowletDir(path.join(dir, ".flowlet")).mcpServers).toEqual([
      { name: "weather", url: "https://mcp.example.com/mcp" },
    ]);
  });

  it("fails loud on a schema-invalid mcp.json", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".flowlet"));
    writeFileSync(
      path.join(dir, ".flowlet/mcp.json"),
      JSON.stringify({ version: 1, servers: [{ name: "x" }] }),
    );
    expect(() => loadFlowletDir(path.join(dir, ".flowlet"))).toThrow(/mcp\.json/);
  });
});
