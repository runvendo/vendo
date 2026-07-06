import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, copyFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractTools } from "./extract-tools.js";

const fixture = path.join(fileURLToPath(new URL(".", import.meta.url)), "../../test/fixtures/openapi/maple.json");

describe("extractTools", () => {
  it("prefers OpenAPI when present and writes a valid manifest", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tools-"));
    await copyFile(fixture, path.join(dir, "openapi.json"));
    const summary = await extractTools(dir, { openapiPath: path.join(dir, "openapi.json") }, null, { force: false });
    const manifest = JSON.parse(await readFile(path.join(dir, ".vendo/tools.json"), "utf8"));
    expect(manifest.version).toBe(1);
    expect(manifest.tools.length).toBe(4);
    expect(manifest.events).toEqual([]);
    // strict contract: no provenance keys in the artifact
    expect(Object.keys(manifest).sort()).toEqual(["events", "tools", "version"]);
    expect(summary.source).toBe("openapi");
  });

  it("extracts deterministic route tools when no spec and no model", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tools-"));
    await mkdir(path.join(dir, "app/api/invoices/[id]"), { recursive: true });
    await writeFile(
      path.join(dir, "app/api/invoices/[id]/route.ts"),
      `export async function GET() {}\nexport async function DELETE() {}\n`,
    );
    const summary = await extractTools(dir, { openapiPath: null }, null, { force: false });
    const manifest = JSON.parse(await readFile(path.join(dir, ".vendo/tools.json"), "utf8"));
    expect(summary.source).toBe("route-scan");
    expect(summary.toolCount).toBe(2);
    expect(summary.errors).toContain("LLM unavailable; route descriptions and input schemas use deterministic placeholders");
    expect(manifest.tools.map((tool: { name: string; annotations: { mutating: boolean; dangerous: boolean } }) => [
      tool.name,
      tool.annotations,
    ])).toEqual([
      ["getInvoicesId", { mutating: false, dangerous: false }],
      ["deleteInvoicesId", { mutating: true, dangerous: true, idempotent: true }],
    ]);
  });

  it("reports skipped when no spec, no route, and no model", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tools-"));
    const summary = await extractTools(dir, { openapiPath: null }, null, { force: false });
    expect(summary.source).toBe("none");
    expect(summary.toolCount).toBe(0);
    expect(summary.errors[0]).toMatch(/ANTHROPIC_API_KEY/);
  });
});
