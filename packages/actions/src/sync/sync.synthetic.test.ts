import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { descriptorHash, VendoError } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { hostToolName, mergeOverrides, vendoSync } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryHost(): Promise<{ root: string; out: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-actions-host-"));
  temporaryDirectories.push(root);
  return { root, out: path.join(root, ".test-vendo") };
}

async function writeFile(root: string, relative: string, source: string): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

function operation(operationId: string, parameters: unknown[] = []): Record<string, unknown> {
  return {
    operationId,
    summary: operationId,
    parameters,
    responses: { "200": { description: "ok" } },
  };
}

async function writeSpec(root: string, paths: Record<string, unknown>): Promise<void> {
  await writeFile(root, "openapi.json", `${JSON.stringify({ openapi: "3.1.0", info: { title: "test", version: "1" }, paths }, null, 2)}\n`);
}

async function toolsAt(out: string): Promise<Array<Record<string, any>>> {
  return (JSON.parse(await fs.readFile(path.join(out, "tools.json"), "utf8")) as { tools: Array<Record<string, any>> }).tools;
}

describe("sync public helpers", () => {
  it("merges only matching overrides field-wise and hashes the merged descriptor", () => {
    const tools: Parameters<typeof mergeOverrides>[0] = [{
      name: "host_items_list",
      description: "old",
      inputSchema: { type: "object", properties: {} },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/items", argsIn: "query" },
    }];
    const before = descriptorHash(tools[0]!);
    const merged = mergeOverrides(tools, {
      format: "vendo/overrides@1",
      tools: {
        host_items_list: { risk: "destructive", disabled: true, description: "new" },
        host_typo_target: { critical: true },
      },
    });
    expect(merged[0]).toMatchObject({ risk: "destructive", disabled: true, description: "new" });
    expect(descriptorHash(merged[0]!)).not.toBe(before);
    expect(merged).toHaveLength(1);
    expect(tools[0]).toMatchObject({ risk: "read", description: "old" });
  });

  it("keeps long route names stable and provider-safe", () => {
    const route = `/api/${"very-long-segment-".repeat(8)}`;
    const first = hostToolName("GET", route);
    expect(first).toBe(hostToolName("GET", route));
    expect(first).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(first).toHaveLength(64);
  });
});

describe("validation and route classification", () => {
  it.each([
    ["invalid JSON", "{"],
    ["unknown override field", JSON.stringify({ format: "vendo/overrides@1", tools: { host_x: { rik: "read" } } })],
  ])("rejects malformed overrides: %s", async (_label, content) => {
    const { root, out } = await temporaryHost();
    await writeFile(out, "overrides.json", content);
    await expect(vendoSync({ root, out })).rejects.toMatchObject({ name: "VendoError", code: "validation" });
  });

  it("emits unclassified app routes disabled and handles catch-all names and deterministic collisions", async () => {
    const { root, out } = await temporaryHost();
    await writeFile(root, "src/app/api/opaque/route.ts", "export const handler = () => null;\n");
    await writeFile(root, "src/app/api/files/[...slug]/route.ts", "export function GET() { return new Response(); }\n");
    await writeFile(root, "src/app/api/reports/[[...parts]]/route.ts", "export function POST() { return new Response(); }\n");
    const page = "export default function handler(req: any, res: any) { if (req.method !== 'GET') return res.end(); res.end(); }\n";
    await writeFile(root, "src/pages/api/foo-bar.ts", page);
    await writeFile(root, "src/pages/api/foo/bar.ts", page);

    await vendoSync({ root, out });
    const tools = await toolsAt(out);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("host_opaque_unclassified")).toMatchObject({ disabled: true, risk: "destructive" });
    expect(byName.get("host_files_get")?.binding.path).toBe("/api/files/{slug}");
    expect(byName.get("host_reports_create")?.binding.path).toBe("/api/reports/{parts}");
    expect(byName.get("host_foo_bar_list")?.binding.path).toBe("/api/foo-bar");
    expect(byName.get("host_foo_bar_list_get")?.binding.path).toBe("/api/foo/bar");
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
  });
});

describe("breaking change diff", () => {
  it("classifies removed and binding-stable renamed operations", async () => {
    const removedHost = await temporaryHost();
    await writeSpec(removedHost.root, { "/api/items": { get: operation("listItems") } });
    await vendoSync(removedHost);
    await writeSpec(removedHost.root, {});
    const removed = await vendoSync(removedHost);
    expect(removed.breaking).toContainEqual({ tool: "host_listItems", change: "removed" });

    const renamedHost = await temporaryHost();
    await writeSpec(renamedHost.root, { "/api/items/{id}": { get: operation("getItem") } });
    await vendoSync(renamedHost);
    await writeSpec(renamedHost.root, { "/api/items/{itemId}": { get: operation("fetchItem") } });
    const renamed = await vendoSync(renamedHost);
    expect(renamed.tools).toMatchObject({ added: ["host_fetchItem"], removed: ["host_getItem"] });
    expect(renamed.breaking).toContainEqual({ tool: "host_getItem", change: "renamed" });
    expect(renamed.breaking).not.toContainEqual({ tool: "host_getItem", change: "removed" });
  });

  it.each([
    [
      "new required property",
      [{ name: "value", in: "query", required: false, schema: { type: "string" } }],
      [{ name: "value", in: "query", required: true, schema: { type: "string" } }],
    ],
    [
      "property removed",
      [{ name: "value", in: "query", schema: { type: "string" } }],
      [],
    ],
    [
      "property type changed",
      [{ name: "value", in: "query", schema: { type: "string" } }],
      [{ name: "value", in: "query", schema: { type: "number" } }],
    ],
    [
      "enum values removed",
      [{ name: "value", in: "query", schema: { type: "string", enum: ["a", "b"] } }],
      [{ name: "value", in: "query", schema: { type: "string", enum: ["a"] } }],
    ],
  ])("detects input narrowing: %s", async (_label, previousParameters, nextParameters) => {
    const host = await temporaryHost();
    await writeSpec(host.root, { "/api/items": { get: operation("listItems", previousParameters) } });
    await vendoSync(host);
    await writeSpec(host.root, { "/api/items": { get: operation("listItems", nextParameters) } });
    const report = await vendoSync(host);
    expect(report.tools.changed).toContain("host_listItems");
    expect(report.breaking).toContainEqual({ tool: "host_listItems", change: "input-narrowed" });
  });

  it("throws strict conflicts only after writing the new artifacts", async () => {
    const host = await temporaryHost();
    await writeSpec(host.root, { "/api/items": { get: operation("listItems") } });
    await vendoSync(host);
    await writeSpec(host.root, { "/api/items": { get: operation("fetchItems") } });

    let thrown: unknown;
    try {
      await vendoSync({ ...host, strict: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VendoError);
    expect(thrown).toMatchObject({ code: "conflict", message: "breaking tool changes" });
    expect((await toolsAt(host.out)).map((tool) => tool.name)).toContain("host_fetchItems");
    expect((await toolsAt(host.out)).map((tool) => tool.name)).not.toContain("host_listItems");
  });
});
