import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VENDO_TOOLS_FORMAT, type ExtractedTool } from "../../src/formats.js";
import { bindingIdentity } from "../../src/sync/common.js";
import { patchToolSchemas } from "../../src/sync/schema-patch.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const blind: ExtractedTool = {
  name: "host_orders_create",
  description: "POST /api/orders",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  inputSchemaSource: "unknown",
  outputSchemaSource: "unknown",
  risk: "write",
  binding: { kind: "route", method: "POST", path: "/api/orders", argsIn: "body" },
};

const declared: ExtractedTool = {
  name: "host_listItems",
  description: "List items",
  inputSchema: { type: "object", properties: {} },
  inputSchemaSource: "declared",
  outputSchemaSource: "unknown",
  risk: "read",
  binding: { kind: "openapi", operationId: "listItems", method: "GET", path: "/api/items" },
};

async function toolsFile(tools: ExtractedTool[]): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-patch-"));
  directories.push(directory);
  const file = path.join(directory, "tools.json");
  await fs.writeFile(file, `${JSON.stringify({ format: VENDO_TOOLS_FORMAT, tools }, null, 2)}\n`, "utf8");
  return file;
}

describe("patchToolSchemas", () => {
  it("fills a blind slot and marks it inferred", async () => {
    const file = await toolsFile([blind]);
    const schema = { type: "object", properties: { merchant: { type: "string" } }, required: ["merchant"] };
    const result = await patchToolSchemas(file, [
      { tool: "host_orders_create", binding: bindingIdentity(blind.binding), slot: "inputSchema", schema },
    ]);

    expect(result.written).toEqual([{ tool: "host_orders_create", slot: "inputSchema" }]);
    expect(result.skipped).toEqual([]);
    const written = JSON.parse(await fs.readFile(file, "utf8")) as { tools: ExtractedTool[] };
    expect(written.tools[0]!.inputSchema).toEqual(schema);
    expect(written.tools[0]!.inputSchemaSource).toBe("inferred");
  });

  it("refuses an occupied slot and leaves the file byte-identical", async () => {
    const file = await toolsFile([declared]);
    const before = await fs.readFile(file, "utf8");
    const result = await patchToolSchemas(file, [
      { tool: "host_listItems", binding: bindingIdentity(declared.binding), slot: "inputSchema", schema: { type: "object" } },
    ]);

    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([{ tool: "host_listItems", slot: "inputSchema", reason: "occupied" }]);
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it("refuses a rebound tool and an unknown tool, byte-identical either way", async () => {
    const file = await toolsFile([blind]);
    const before = await fs.readFile(file, "utf8");
    const result = await patchToolSchemas(file, [
      { tool: "host_orders_create", binding: "ROUTE POST /api/elsewhere", slot: "outputSchema", schema: { type: "object" } },
      { tool: "host_nope", binding: "whatever", slot: "outputSchema", schema: { type: "object" } },
    ]);

    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([
      { tool: "host_orders_create", slot: "outputSchema", reason: "rebound" },
      { tool: "host_nope", slot: "outputSchema", reason: "unknown-tool" },
    ]);
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it("does nothing at all when there are no patches, or when the file is absent", async () => {
    const file = await toolsFile([blind]);
    expect(await patchToolSchemas(file, [])).toEqual({ written: [], skipped: [] });
    expect(await patchToolSchemas(path.join(path.dirname(file), "missing.json"), [
      { tool: "host_orders_create", binding: "x", slot: "inputSchema", schema: {} },
    ])).toEqual({ written: [], skipped: [{ tool: "host_orders_create", slot: "inputSchema", reason: "unknown-tool" }] });
  });
});
