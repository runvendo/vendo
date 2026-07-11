import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultBrand } from "@vendoai/components/theme";
import { loadVendoDir } from "./vendo-dir.js";

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

  it("fails loud when a file is PRESENT but unreadable (EACCES/EIO class) instead of silently serving defaults", () => {
    const dir = scratch();
    // A directory named tools.json makes readFileSync throw EISDIR — the same
    // not-ENOENT class as EACCES/EIO, reproducible without root/chmod tricks.
    mkdirSync(path.join(dir, ".vendo/tools.json"), { recursive: true });
    expect(() => loadVendoDir(path.join(dir, ".vendo"))).toThrow(
      /tools\.json exists but could not be read/,
    );
  });

  it("fails loud on invalid JSON in theme.json", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".vendo"));
    writeFileSync(path.join(dir, ".vendo/theme.json"), "{nope");
    expect(() => loadVendoDir(path.join(dir, ".vendo"))).toThrow(/theme\.json/);
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
