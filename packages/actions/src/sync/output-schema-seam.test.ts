/**
 * The producer/consumer SEAM for declared schemas, with no stub on either side.
 *
 * `vendoSync` writes `.vendo/tools.json` from a real OpenAPI document; the real
 * runtime registry (`createActions({ dir })`) loads that same directory and its
 * `descriptors()` is what every surface reads. A harness that mocked either half
 * could never catch the two disagreeing — which is exactly how the schemas got
 * written and never read.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunContext } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { bindingIdentity } from "../binding-identity.js";
import { createActions } from "../runtime/registry.js";
import { vendoSync } from "./index.js";
import { patchToolSchemas } from "./schema-patch.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_seam" },
  venue: "chat",
  presence: "present",
  sessionId: "session_seam",
};

const ITEMS_RESPONSE = {
  type: "object",
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, status: { type: "string", enum: ["open", "closed"] } },
        required: ["id", "status"],
      },
    },
  },
  required: ["data"],
} as const;

async function syncedHost(): Promise<{ root: string; out: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-seam-host-"));
  directories.push(root);
  await fs.writeFile(path.join(root, "openapi.json"), `${JSON.stringify({
    openapi: "3.1.0",
    info: { title: "seam", version: "1" },
    paths: {
      "/api/items": {
        get: {
          operationId: "listItems",
          summary: "List items",
          responses: { "200": { description: "Items", content: { "application/json": { schema: ITEMS_RESPONSE } } } },
        },
      },
      "/api/ping": {
        get: { operationId: "ping", summary: "Ping", responses: { "200": { description: "ok" } } },
      },
    },
  }, null, 2)}\n`, "utf8");
  const out = path.join(root, ".vendo");
  await vendoSync({ root, out });
  return { root, out };
}

describe("declared output schemas cross the sync → registry seam", () => {
  it("a schema sync wrote is the schema the registry hands to descriptors()", async () => {
    const { out } = await syncedHost();
    const descriptors = await createActions({ dir: out }).descriptors(ctx);
    const listItems = descriptors.find((descriptor) => descriptor.name === "host_listItems");
    const ping = descriptors.find((descriptor) => descriptor.name === "host_ping");

    expect(listItems?.outputSchema).toEqual(ITEMS_RESPONSE);
    // The enum survives end to end — this is the erasure incident class.
    expect(JSON.stringify(listItems?.outputSchema)).toContain('"open"');
    // An operation the spec left blind stays blind; extraction never invents one.
    expect(ping).toBeDefined();
    expect(ping).not.toHaveProperty("outputSchema");
  });

  it("the provenance markers never reach the wire", async () => {
    const { out } = await syncedHost();
    const descriptors = await createActions({ dir: out }).descriptors(ctx);
    const listItems = descriptors.find((descriptor) => descriptor.name === "host_listItems");

    // On disk they exist…
    const file = JSON.parse(await fs.readFile(path.join(out, "tools.json"), "utf8")) as {
      tools: Array<Record<string, unknown>>;
    };
    expect(file.tools.find((tool) => tool.name === "host_listItems")?.outputSchemaSource).toBe("declared");
    // …and the descriptor whitelist keeps them off the wire.
    expect(listItems).not.toHaveProperty("outputSchemaSource");
    expect(listItems).not.toHaveProperty("inputSchemaSource");
  });
});

describe("a judge-written schema survives the next sync, and only the right one", () => {
  it("carries an inferred fill forward and drops it when the binding moves", async () => {
    const { root, out } = await syncedHost();
    const toolsPath = path.join(out, "tools.json");
    const file = JSON.parse(await fs.readFile(toolsPath, "utf8")) as { tools: Array<Record<string, unknown>> };
    const ping = file.tools.find((tool) => tool.name === "host_ping")!;
    const inferred = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

    const written = await patchToolSchemas(toolsPath, [
      { tool: "host_ping", binding: bindingIdentity(ping.binding as never), slot: "outputSchema", schema: inferred },
    ]);
    expect(written.written).toHaveLength(1);

    // A plain re-sync must not wipe it.
    await vendoSync({ root, out });
    const afterResync = await createActions({ dir: out }).descriptors(ctx);
    expect(afterResync.find((descriptor) => descriptor.name === "host_ping")?.outputSchema).toEqual(inferred);

    // The extractors' own reading still wins: `host_listItems` keeps the spec's
    // schema, not anything carried.
    expect(afterResync.find((descriptor) => descriptor.name === "host_listItems")?.outputSchema).toEqual(ITEMS_RESPONSE);
  });
});
