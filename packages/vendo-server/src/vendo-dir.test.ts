import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultBrand } from "@vendoai/components/theme";
import { loadVendoDir } from "./vendo-dir";

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "vendo-next-"));
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

describe("loadVendoDir", () => {
  it("reads theme.json and tools.json", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".vendo"));
    writeFileSync(path.join(dir, ".vendo/theme.json"), JSON.stringify(THEME));
    writeFileSync(path.join(dir, ".vendo/tools.json"), JSON.stringify(TOOLS));
    const loaded = loadVendoDir(path.join(dir, ".vendo"));
    expect(loaded.brand.accent).toBe("#0A7CFF");
    expect(loaded.manifest.tools).toHaveLength(1);
    expect(loaded.manifest.events).toEqual([]);
  });

  it("falls back to the default brand and an empty manifest when .vendo/ is absent", () => {
    const loaded = loadVendoDir(path.join(scratch(), ".vendo"));
    expect(loaded.brand).toEqual(defaultBrand);
    expect(loaded.manifest.tools).toEqual([]);
  });

  it("fails loud on a schema-invalid tools.json (developer-editable file)", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".vendo"));
    writeFileSync(path.join(dir, ".vendo/tools.json"), JSON.stringify({ version: 1, tools: [{}] }));
    expect(() => loadVendoDir(path.join(dir, ".vendo"))).toThrow(/tools\.json/);
  });

  it("fails loud on invalid JSON in theme.json", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".vendo"));
    writeFileSync(path.join(dir, ".vendo/theme.json"), "{nope");
    expect(() => loadVendoDir(path.join(dir, ".vendo"))).toThrow(/theme\.json/);
  });

  it("reads vendo sync artifacts: remix-sources.json + env/manifest.json (absent → defaults)", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".vendo/env"), { recursive: true });
    writeFileSync(
      path.join(dir, ".vendo/remix-sources.json"),
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
      path.join(dir, ".vendo/env/manifest.json"),
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
    const loaded = loadVendoDir(path.join(dir, ".vendo"));
    expect(loaded.remixSources["upcoming-deadlines"]?.exportName).toBe("DeadlineList");
    expect(loaded.envManifest?.anchors["upcoming-deadlines"]?.["swr"]).toEqual({
      kind: "shimmed",
      note: "anchor data",
    });

    // Absent → defaults, not errors.
    const empty = loadVendoDir(path.join(scratch(), ".vendo"));
    expect(empty.remixSources).toEqual({});
    expect(empty.envManifest).toBeUndefined();
  });

  it("fails loud on schema-invalid remix-sources.json and env/manifest.json", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".vendo"));
    writeFileSync(path.join(dir, ".vendo/remix-sources.json"), JSON.stringify({ a: { file: "" } }));
    expect(() => loadVendoDir(path.join(dir, ".vendo"))).toThrow(/remix-sources\.json/);

    const dir2 = scratch();
    mkdirSync(path.join(dir2, ".vendo/env"), { recursive: true });
    writeFileSync(path.join(dir2, ".vendo/env/manifest.json"), JSON.stringify({ anchors: { a: { x: { kind: "??" } } } }));
    expect(() => loadVendoDir(path.join(dir2, ".vendo"))).toThrow(/manifest\.json/);
  });

  it("returns undefined mcpServers when mcp.json is absent (zero-config)", () => {
    const loaded = loadVendoDir(path.join(scratch(), ".vendo"));
    expect(loaded.mcpServers).toBeUndefined();
  });

  it("loads and validates mcp.json when present", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".vendo"));
    writeFileSync(
      path.join(dir, ".vendo/mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [{ name: "weather", url: "https://mcp.example.com/mcp" }],
      }),
    );
    expect(loadVendoDir(path.join(dir, ".vendo")).mcpServers).toEqual([
      { name: "weather", url: "https://mcp.example.com/mcp" },
    ]);
  });

  it("fails loud on a schema-invalid mcp.json", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".vendo"));
    writeFileSync(
      path.join(dir, ".vendo/mcp.json"),
      JSON.stringify({ version: 1, servers: [{ name: "x" }] }),
    );
    expect(() => loadVendoDir(path.join(dir, ".vendo"))).toThrow(/mcp\.json/);
  });
});
