import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { descriptorHash, VendoError } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtractedTool } from "../../src/formats.js";
import { routeToolFullName, withUniqueNames } from "../../src/sync/common.js";
import { inputNarrowed, mergeOverrides, vendoSync } from "../../src/sync/index.js";

/** The proven wrapper-import specifier fixtures write to disk. Assembled at
 *  runtime because the dependency guard's static text scan reads
 *  import-shaped strings even inside fixtures, and actions may not import
 *  @vendoai/ui. */
const UI_CHROME = ["@vendoai", "ui", "chrome"].join("/");
const VENDO_REACT = ["@vendoai", "vendo", "react"].join("/");

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

function extracted(inputSchema: Record<string, unknown>): ExtractedTool {
  return {
    name: "host_probe",
    description: "Probe",
    inputSchema,
    risk: "read",
    binding: { kind: "route", method: "GET", path: "/api/probe", argsIn: "query" },
  };
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
      format: "vendo/overrides@3",
      tools: {
        host_items_list: { risk: "destructive", disabled: true, description: "new" },
        host_typo_target: { confirmEach: true },
      },
    });
    expect(merged[0]).toMatchObject({ risk: "destructive", disabled: true, description: "new" });
    expect(descriptorHash(merged[0]!)).not.toBe(before);
    expect(merged).toHaveLength(1);
    expect(tools[0]).toMatchObject({ risk: "read", description: "old" });
  });

  it("keeps long route names stable and provider-safe", () => {
    const route = `/api/${"very-long-segment-".repeat(8)}`;
    const toolName = (method: "GET", routePath: string): string => withUniqueNames([{
      name: routeToolFullName(method, routePath),
      description: "",
      inputSchema: {},
      risk: "write",
      binding: { kind: "route", method, path: routePath, argsIn: "body" },
    }])[0]!.name;
    const first = toolName("GET", route);
    expect(first).toBe(toolName("GET", route));
    expect(first).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(first).toHaveLength(64);
  });
});

describe("validation and route classification", () => {
  it.each([
    ["invalid JSON", "{"],
    ["unknown override field", JSON.stringify({ format: "vendo/overrides@3", tools: { host_x: { rik: "read" } } })],
  ])("rejects malformed overrides: %s", async (_label, content) => {
    const { root, out } = await temporaryHost();
    await writeFile(out, "overrides.json", content);
    await expect(vendoSync({ root, out })).rejects.toMatchObject({ name: "VendoError", code: "validation" });
  });

  it("fails loudly when an existing catalog.json violates the strict schema", async () => {
    const { root, out } = await temporaryHost();
    await writeFile(out, "catalog.json", JSON.stringify({
      format: "vendo/catalog@1",
      entries: [],
      typo: true,
    }));

    await expect(vendoSync({ root, out })).rejects.toMatchObject({
      name: "VendoError",
      code: "validation",
      message: expect.stringContaining(`malformed catalog file: ${path.join(out, "catalog.json")}`),
    });
  });

  // Two full TS-compiler scans back to back run long under CI coverage instrumentation.
  it("writes byte-identical catalog.json content on consecutive syncs", { timeout: 120_000 }, async () => {
    const { root, out } = await temporaryHost();
    await writeFile(root, "tsconfig.json", JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true },
      include: ["src"],
    }));
    await writeFile(root, "src/components.tsx", `
      type ComponentType = (props: unknown) => unknown;
      function StableCard({ label }: { label: string }) { return <article>{label}</article>; }
      export const hostComponents: Record<string, ComponentType> = { StableCard: StableCard as ComponentType };
      export function Root() { return <VendoRoot components={hostComponents} />; }
    `);

    const first = await vendoSync({ root, out });
    const firstBytes = await fs.readFile(path.join(out, "catalog.json"), "utf8");
    const second = await vendoSync({ root, out });
    expect(first.catalog).toEqual({ discovered: 1, registered: 0 });
    expect(second.catalog).toEqual(first.catalog);
    expect(await fs.readFile(path.join(out, "catalog.json"), "utf8")).toBe(firstBytes);
  });

  it("emits unclassified app routes disabled and handles catch-all names and deterministic collisions", async () => {
    const { root, out } = await temporaryHost();
    await writeFile(root, "src/app/api/opaque/route.ts", "export const handler = () => null;\n");
    await writeFile(root, "src/app/api/files/[...slug]/route.ts", "export function GET() { return new Response(); }\n");
    await writeFile(root, "src/app/api/reports/[[...parts]]/route.ts", "export function POST() { return new Response(); }\n");
    await writeFile(
      root,
      "src/app/api/comment-only/route.ts",
      "const marker = `// not a comment`;\n// export function GET() { return new Response(); }\n/* export const POST = handler; */\n",
    );
    const page = "export default function handler(req: any, res: any) { if (req.method !== 'GET') return res.end(); res.end(); }\n";
    await writeFile(root, "src/pages/api/foo-bar.ts", page);
    await writeFile(root, "src/pages/api/foo/bar.ts", page);

    await vendoSync({ root, out });
    const tools = await toolsAt(out);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("host_opaque_unclassified")).toMatchObject({ disabled: true, risk: "ungraded" });
    expect(byName.get("host_files_get")?.binding.path).toBe("/api/files/{slug}");
    expect(byName.get("host_reports_create")?.binding.path).toBe("/api/reports/{parts}");
    expect(byName.get("host_comment_only_unclassified")).toMatchObject({
      disabled: true,
      binding: { method: "POST", path: "/api/comment-only" },
    });
    expect(byName.get("host_foo_bar_list")?.binding.path).toBe("/api/foo-bar");
    expect(byName.get("host_foo_bar_list_get")?.binding.path).toBe("/api/foo/bar");
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
  });

  it("warns for unmatched host overrides but keeps connector-target overrides silent", async () => {
    const { root, out } = await temporaryHost();
    await writeSpec(root, { "/api/items": { get: operation("listItems") } });
    await writeFile(out, "overrides.json", JSON.stringify({
      format: "vendo/overrides@3",
      tools: { host_missing: { disabled: true }, connector_missing: { risk: "read" } },
    }));

    const report = await vendoSync({ root, out });
    expect(report.warnings).toContain("host override host_missing did not match any extracted tool");
    expect(report.warnings.some((warning) => warning.includes("connector_missing"))).toBe(false);
  });

  /** #1056: a standing judgment whose binding moved is held INERT by
   *  `applyJudgment`, so its tool silently falls back to `ungraded` and asks on
   *  every call. Nothing said so on the keyless path — the only path that cannot
   *  re-grade — because `pruneJudgments` runs solely inside the keyed judge pass.
   *  Sync is where a host finds out. */
  it("warns when a standing judgment's binding no longer matches its tool", async () => {
    const { root, out } = await temporaryHost();
    await writeSpec(root, { "/api/items": { get: operation("listItems") } });
    await writeFile(out, "judgments.json", JSON.stringify({
      format: "vendo/judgments@1",
      tools: {
        host_listItems: { binding: "GET /mount/api/items", fields: { risk: "read" }, evidence: "return items;" },
        host_departed: { binding: "GET /api/departed", fields: { risk: "read" }, evidence: "return gone;" },
      },
    }));

    const report = await vendoSync({ root, out });
    const stranded = report.warnings.filter((warning) => warning.includes("standing judgment"));
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toContain("1/1 standing judgments no longer match their tool");
    expect(stranded[0]).toContain(`host_listItems was graded against "GET /mount/api/items", now "GET /api/items"`);
    // A judgment for a tool the catalog no longer carries is ordinary churn the
    // next keyed sync prunes — not a stranded grade, so not this host's problem.
    expect(stranded[0]).not.toContain("host_departed");
  });

  it("stays silent when every standing judgment still binds to its tool", async () => {
    const { root, out } = await temporaryHost();
    await writeSpec(root, { "/api/items": { get: operation("listItems") } });
    await writeFile(out, "judgments.json", JSON.stringify({
      format: "vendo/judgments@1",
      tools: { host_listItems: { binding: "GET /api/items", fields: { risk: "read" }, evidence: "return items;" } },
    }));

    const report = await vendoSync({ root, out });
    expect(report.warnings.filter((warning) => warning.includes("standing judgment"))).toEqual([]);
  });

  it("reports loud wrapper errors and honors the per-slot ignore list", async () => {
    const inlineHost = await temporaryHost();
    await writeFile(
      inlineHost.root,
      "src/app/page.tsx",
      `import { Remixable } from "${UI_CHROME}";\n` +
      `export default function Page() { return <Remixable><div>inline</div></Remixable>; }\n`,
    );
    const inline = await vendoSync(inlineHost);
    expect(inline.remixableErrors).toEqual([
      expect.stringContaining("src/app/page.tsx:2"),
    ]);
    expect(inline.remixableErrors[0]).toContain("extract it into a component and wrap that");

    const ignoredHost = await temporaryHost();
    await writeFile(ignoredHost.root, "src/components/Card.tsx", "export function Card() { return <div>card</div>; }\n");
    await writeFile(
      ignoredHost.root,
      "src/app/page.tsx",
      `import { Remixable } from "${UI_CHROME}";\n` +
      `import { Card } from "../components/Card";\n` +
      `export default function Page() { return <Remixable><Card /></Remixable>; }\n`,
    );
    await writeFile(ignoredHost.out, "overrides.json", JSON.stringify({
      format: "vendo/overrides@3",
      tools: {},
      remix: { ignoreSlots: ["Card"] },
    }));
    const ignored = await vendoSync(ignoredHost);
    expect(ignored.remixableErrors).toEqual([]);
    expect(ignored.pins.captured).toEqual([]);
  });

  it("no longer captures registry remixable: true registrations", async () => {
    const host = await temporaryHost();
    await writeFile(host.root, "src/components/Card.tsx", "export function Card() { return <div>card</div>; }\n");
    await writeFile(
      host.root,
      "src/vendo/components.tsx",
      `import { Card } from "../components/Card";\n` +
      `export const components = [{ name: "Card", component: Card, remixable: true }];\n`,
    );
    const report = await vendoSync(host);
    expect(report.remixableErrors).toEqual([]);
    expect(report.pins.captured).toEqual([]);
    await expect(fs.access(path.join(host.out, "remixable", "Card.json"))).rejects.toThrow();
  });

  it("allocates colliding sanitized names independently of OpenAPI declaration order", async () => {
    const { root, out } = await temporaryHost();
    const firstPaths = {
      "/api/zeta": { get: operation("get.item") },
      "/api/alpha": { get: operation("get_item") },
    };
    await writeSpec(root, firstPaths);
    await vendoSync({ root, out });
    const first = Object.fromEntries((await toolsAt(out)).map((tool) => [tool.name, tool.binding.path]));

    await writeSpec(root, Object.fromEntries(Object.entries(firstPaths).reverse()));
    await vendoSync({ root, out });
    const second = Object.fromEntries((await toolsAt(out)).map((tool) => [tool.name, tool.binding.path]));
    expect(second).toEqual(first);
  });

  it("keeps optional request bodies optional and skips header and cookie parameters", async () => {
    const { root, out } = await temporaryHost();
    await writeSpec(root, {
      "/api/items/{id}": {
        post: {
          ...operation("createItem", [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "query", in: "query", schema: { type: "string" } },
            { name: "legacy", required: false, schema: { type: "string" } },
            { name: "authorization", in: "header", required: true, schema: { type: "string" } },
            { name: "session", in: "cookie", required: true, schema: { type: "string" } },
          ]),
          requestBody: {
            required: false,
            content: { "application/json": { schema: { type: "object", properties: { value: { type: "string" } } } } },
          },
        },
      },
    });

    await vendoSync({ root, out });
    const tool = (await toolsAt(out)).find((item) => item.name === "host_createItem")!;
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["body", "id", "legacy", "query"]);
    expect(tool.inputSchema.required).toEqual(["id"]);
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

  it("treats a same-named binding change as removal while retaining changed", async () => {
    const host = await temporaryHost();
    await writeSpec(host.root, { "/api/old": { get: operation("listItems") } });
    await vendoSync(host);
    await writeSpec(host.root, { "/api/new": { get: operation("listItems") } });
    const report = await vendoSync(host);
    expect(report.tools.changed).toContain("host_listItems");
    expect(report.breaking).toContainEqual({ tool: "host_listItems", change: "removed" });
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
    [
      "enum added to an unconstrained property",
      [{ name: "value", in: "query", schema: { type: "string" } }],
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

  it("detects additionalProperties tightening at the top level", () => {
    expect(inputNarrowed(
      extracted({ type: "object", properties: {}, additionalProperties: true }),
      extracted({ type: "object", properties: {}, additionalProperties: false }),
    )).toBe(true);
    expect(inputNarrowed(
      extracted({ type: "object", properties: {} }),
      extracted({ type: "object", properties: {}, additionalProperties: false }),
    )).toBe(true);
  });

  it("does not flag property type widenings as narrowing", () => {
    expect(inputNarrowed(
      extracted({ type: "object", properties: { value: { type: "number" } } }),
      extracted({ type: "object", properties: { value: { type: ["number", "string"] } } }),
    )).toBe(false);
    expect(inputNarrowed(
      extracted({ type: "object", properties: { value: { type: "number" } } }),
      extracted({ type: "object", properties: { value: {} } }),
    )).toBe(false);
  });

  it("flags property type narrowings", () => {
    expect(inputNarrowed(
      extracted({ type: "object", properties: { value: { type: ["number", "string"] } } }),
      extracted({ type: "object", properties: { value: { type: "number" } } }),
    )).toBe(true);
    expect(inputNarrowed(
      extracted({ type: "object", properties: { value: {} } }),
      extracted({ type: "object", properties: { value: { type: "number" } } }),
    )).toBe(true);
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

describe("declared response bodies", () => {
  const envelope = {
    type: "object",
    properties: { data: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } } },
    required: ["data"],
  };

  it("records a 2xx application/json schema as the tool's outputSchema", async () => {
    const host = await temporaryHost();
    // The whole document (not writeSpec): the schema rides a components $ref,
    // so the extractor's ref resolution is under test too.
    await writeFile(host.root, "openapi.json", JSON.stringify({
      openapi: "3.1.0",
      info: { title: "test", version: "1" },
      paths: {
        "/api/items": {
          get: {
            operationId: "listItems",
            summary: "List items",
            responses: { "200": { description: "Items", content: { "application/json": { schema: { $ref: "#/components/schemas/Items" } } } } },
          },
        },
      },
      components: { schemas: { Items: envelope } },
    }));
    await vendoSync(host);

    const tool = (await toolsAt(host.out)).find((entry) => entry.name === "host_listItems");
    // Refs resolve: the recorded schema is the real envelope, not a pointer.
    expect(tool?.outputSchema).toEqual(envelope);
  });

  it("records nothing when the spec declares no response schema", async () => {
    const host = await temporaryHost();
    await writeSpec(host.root, { "/api/items": { get: operation("listItems") } });
    await vendoSync(host);

    expect((await toolsAt(host.out)).find((entry) => entry.name === "host_listItems")).not.toHaveProperty("outputSchema");
  });
});

describe("the provider→components seam", () => {
  /** No mock on either side: real source in, real vendoSync, real .vendo/
   *  artifacts read back off disk. The host-component previews shipped four
   *  times green-and-dead because the producer and the consumer each mocked
   *  the other. */
  it("captures the components a <VendoProvider> registers", { timeout: 120_000 }, async () => {
    const { root, out } = await temporaryHost();
    await writeSpec(root, {});
    await writeFile(root, "tsconfig.json", `${JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true },
      include: ["src"],
    })}\n`);
    await writeFile(root, "src/vendo-root.tsx", `
      import { VendoProvider } from "${VENDO_REACT}";
      type ComponentType = (props: unknown) => unknown;
      export function BalanceCard({ label, cents }: { label: string; cents: number }) {
        return <article>{label}{cents}</article>;
      }
      export const registry: Record<string, ComponentType> = { BalanceCard: BalanceCard as ComponentType };
      export function Root({ children }: { children: unknown }) {
        return <VendoProvider components={registry}>{children}</VendoProvider>;
      }
    `);

    const report = await vendoSync({ root, out });
    expect(report.catalog.discovered).toBeGreaterThan(0);

    const catalog = JSON.parse(await fs.readFile(path.join(out, "catalog.json"), "utf8")) as {
      entries: Array<{ name: string }>;
    };
    expect(catalog.entries.map((entry) => entry.name)).toContain("BalanceCard");

    // The consumer's half of the seam: the captured record vendo-web reads.
    const record = JSON.parse(await fs.readFile(path.join(out, "components", "BalanceCard.json"), "utf8")) as {
      name: string;
    };
    expect(record.name).toBe("BalanceCard");
  });
});

describe("schema source markers and coverage", () => {
  it("counts both slots, keeps a declared empty input out of the blind list", async () => {
    const host = await temporaryHost();
    await writeSpec(host.root, {
      "/api/items": { get: operation("listItems") },
      "/api/items/{id}": {
        get: operation("getItem", [{ name: "id", in: "path", required: true, schema: { type: "string" } }]),
      },
    });
    const report = await vendoSync(host);

    expect(report.toolSchemas.total).toBe(2);
    // An OpenAPI operation that declares no parameters HAS declared its
    // argument list; it is not blind.
    expect(report.toolSchemas.inputs).toEqual({ known: 2, unknown: [] });
    expect(report.toolSchemas.outputs).toEqual({ known: 0, unknown: ["host_getItem", "host_listItems"] });
  });

  it("carries an inferred schema across a re-sync and drops it when the binding moves", async () => {
    const host = await temporaryHost();
    await writeSpec(host.root, { "/api/items": { get: operation("listItems") } });
    await vendoSync(host);

    const toolsPath = path.join(host.out, "tools.json");
    const file = JSON.parse(await fs.readFile(toolsPath, "utf8")) as { tools: Array<Record<string, any>> };
    const inferred = { type: "object", properties: { data: { type: "array" } } };
    file.tools[0]!.outputSchema = inferred;
    file.tools[0]!.outputSchemaSource = "inferred";
    await fs.writeFile(toolsPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");

    await vendoSync(host);
    const carried = (await toolsAt(host.out)).find((tool) => tool.name === "host_listItems");
    expect(carried?.outputSchema).toEqual(inferred);
    expect(carried?.outputSchemaSource).toBe("inferred");

    // Same name, different handler: the stale inferred schema must not follow.
    await writeSpec(host.root, { "/api/moved": { get: operation("listItems") } });
    await vendoSync(host);
    const rebound = (await toolsAt(host.out)).find((tool) => tool.name === "host_listItems");
    expect(rebound).not.toHaveProperty("outputSchema");
    expect(rebound?.outputSchemaSource).toBe("unknown");
  });

  it("does not report a blind-to-filled input as breaking, and strict does not throw on it", async () => {
    const previous: ExtractedTool = {
      name: "host_orders_create",
      description: "POST /api/orders",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      inputSchemaSource: "unknown",
      risk: "write",
      binding: { kind: "route", method: "POST", path: "/api/orders", argsIn: "body" },
    };
    const filled: ExtractedTool = {
      ...previous,
      inputSchema: {
        type: "object",
        properties: { merchant: { type: "string" } },
        required: ["merchant"],
        additionalProperties: false,
      },
      inputSchemaSource: "inferred",
    };
    expect(inputNarrowed(previous, filled)).toBe(false);
    // A real narrowing between two KNOWN inputs is still breaking.
    expect(inputNarrowed({ ...filled, inputSchemaSource: "declared" }, {
      ...filled,
      inputSchema: {
        type: "object",
        properties: { merchant: { type: "string" }, hour: { type: "number" } },
        required: ["merchant", "hour"],
        additionalProperties: false,
      },
    })).toBe(true);
  });
});
