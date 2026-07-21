import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanRoutes } from "./route-scan.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-actions-routes-"));
  temporaryDirectories.push(root);
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

async function methodsFor(root: string, urlPath: string): Promise<string[]> {
  const { tools } = await scanRoutes(root);
  return tools
    .filter((tool) => tool.binding.kind === "route" && tool.binding.path === urlPath && !tool.disabled)
    .map((tool) => (tool.binding.kind === "route" ? tool.binding.method : ""))
    .sort();
}

// Path-params-only input schema, the shape every route-bound tool carries
// until a collector (route-schema.ts, PR 2) recognizes something richer.
function blankInput(properties: Record<string, unknown> = {}): Record<string, unknown> {
  const required = Object.keys(properties);
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: true,
  };
}

describe("app route verb evidence", () => {
  it("reads exported declarations, declaration lists, and destructured exports", async () => {
    const root = await temporaryRoot();
    await write(root, "app/api/fn/route.ts", "export async function GET() { return new Response(); }\n");
    await write(root, "app/api/list/route.ts", "const handler = () => new Response();\nexport const runtime = \"edge\", POST = handler;\n");
    await write(root, "app/api/pair/route.ts", "const handlers = { GET: () => null, PUT: () => null };\nexport const { GET, PUT } = handlers;\n");

    expect(await methodsFor(root, "/api/fn")).toEqual(["GET"]);
    expect(await methodsFor(root, "/api/list")).toEqual(["POST"]);
    expect(await methodsFor(root, "/api/pair")).toEqual(["GET", "PUT"]);

    // Byte-identical baseline (no-regression net for the whole route-schema
    // inference PR — harvested from today's scanRoutes output).
    expect(await scanRoutes(root)).toEqual({
      tools: [
        { name: "host_fn_list", description: "GET /api/fn", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "GET", path: "/api/fn", argsIn: "query" } },
        { name: "host_list_create", description: "POST /api/list", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "POST", path: "/api/list", argsIn: "body" } },
        { name: "host_pair_list", description: "GET /api/pair", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "GET", path: "/api/pair", argsIn: "query" } },
        { name: "host_pair_update", description: "PUT /api/pair", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "PUT", path: "/api/pair", argsIn: "body" } },
      ],
      warnings: [],
    });
  });

  it("reads local aliased export lists and ignores non-verb names", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "app/api/aliased/route.ts",
      "async function handle() { return new Response(); }\nexport { handle as PATCH, handle as helper };\n",
    );
    expect(await methodsFor(root, "/api/aliased")).toEqual(["PATCH"]);

    expect(await scanRoutes(root)).toEqual({
      tools: [
        { name: "host_aliased_update", description: "PATCH /api/aliased", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "PATCH", path: "/api/aliased", argsIn: "body" } },
      ],
      warnings: [],
    });
  });

  it("follows named and star re-exports to the implementing module", async () => {
    const root = await temporaryRoot();
    await write(root, "lib/impl.ts", "export function GET() { return new Response(); }\nexport function DELETE() { return new Response(); }\n");
    await write(root, "app/api/named/route.ts", "export { GET } from \"../../../lib/impl\";\n");
    await write(root, "app/api/star/route.ts", "export * from \"../../../lib/impl\";\n");

    // A named verb re-export marks the target module as route evidence; the
    // route then carries every verb the target exports (long-standing union
    // semantics — the corpus locks it).
    expect(await methodsFor(root, "/api/named")).toEqual(["DELETE", "GET"]);
    expect(await methodsFor(root, "/api/star")).toEqual(["DELETE", "GET"]);

    expect(await scanRoutes(root)).toEqual({
      tools: [
        { name: "host_named_list", description: "GET /api/named", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "GET", path: "/api/named", argsIn: "query" } },
        { name: "host_named_delete", description: "DELETE /api/named", inputSchema: blankInput(), risk: "destructive",
          binding: { kind: "route", method: "DELETE", path: "/api/named", argsIn: "query" } },
        { name: "host_star_list", description: "GET /api/star", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "GET", path: "/api/star", argsIn: "query" } },
        { name: "host_star_delete", description: "DELETE /api/star", inputSchema: blankInput(), risk: "destructive",
          binding: { kind: "route", method: "DELETE", path: "/api/star", argsIn: "query" } },
      ],
      warnings: [],
    });
  });

  it("keeps re-exported verbs when the route also declares inline verbs", async () => {
    const root = await temporaryRoot();
    await write(root, "lib/post-impl.ts", "export function POST() { return new Response(); }\n");
    await write(
      root,
      "app/api/mixed/route.ts",
      "export async function GET() { return new Response(); }\nexport { POST } from \"../../../lib/post-impl\";\n",
    );
    expect(await methodsFor(root, "/api/mixed")).toEqual(["GET", "POST"]);

    expect(await scanRoutes(root)).toEqual({
      tools: [
        { name: "host_mixed_list", description: "GET /api/mixed", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "GET", path: "/api/mixed", argsIn: "query" } },
        { name: "host_mixed_create", description: "POST /api/mixed", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "POST", path: "/api/mixed", argsIn: "body" } },
      ],
      warnings: [],
    });
  });

  it("ignores verb-looking text inside strings and comments", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "app/api/noise/route.ts",
      "// export function GET() {}\nconst usage = \"export function POST\";\nexport function PUT() { return new Response(usage); }\n",
    );
    expect(await methodsFor(root, "/api/noise")).toEqual(["PUT"]);

    expect(await scanRoutes(root)).toEqual({
      tools: [
        { name: "host_noise_update", description: "PUT /api/noise", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "PUT", path: "/api/noise", argsIn: "body" } },
      ],
      warnings: [],
    });
  });

  it("classifies a defaultHandler verb-keyed object argument", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "app/api/keyed/route.ts",
      "import { defaultHandler } from \"../../../lib/router\";\nconst run = defaultHandler({ GET: () => null, \"POST\": () => null, other: () => null });\nexport default run;\n",
    );
    expect(await methodsFor(root, "/api/keyed")).toEqual(["GET", "POST"]);

    expect(await scanRoutes(root)).toEqual({
      tools: [
        { name: "host_keyed_list", description: "GET /api/keyed", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "GET", path: "/api/keyed", argsIn: "query" } },
        { name: "host_keyed_create", description: "POST /api/keyed", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "POST", path: "/api/keyed", argsIn: "body" } },
      ],
      warnings: [],
    });
  });

  it("assigns route-map entries to collection, item, and catch-all routes", async () => {
    const root = await temporaryRoot();
    const routeMap = [
      "const routes = {",
      "  \"GET /\": () => null,",
      "  \"POST /\": () => null,",
      "  \"PUT /:id\": () => null,",
      "};",
      "export default routes;",
    ].join("\n");
    await write(root, "app/api/things/route.ts", routeMap);
    await write(root, "app/api/things/[id]/route.ts", routeMap);
    await write(root, "app/api/blob/[...rest]/route.ts", routeMap);

    expect(await methodsFor(root, "/api/things")).toEqual(["GET", "POST"]);
    expect(await methodsFor(root, "/api/things/{id}")).toEqual(["PUT"]);
    expect(await methodsFor(root, "/api/blob/{rest}")).toEqual(["GET", "POST", "PUT"]);

    expect(await scanRoutes(root)).toEqual({
      tools: [
        { name: "host_blob_get", description: "GET /api/blob/{rest}", inputSchema: blankInput({ rest: { type: "string" } }), risk: "write",
          binding: { kind: "route", method: "GET", path: "/api/blob/{rest}", argsIn: "query" } },
        { name: "host_blob_create", description: "POST /api/blob/{rest}", inputSchema: blankInput({ rest: { type: "string" } }), risk: "write",
          binding: { kind: "route", method: "POST", path: "/api/blob/{rest}", argsIn: "body" } },
        { name: "host_blob_update", description: "PUT /api/blob/{rest}", inputSchema: blankInput({ rest: { type: "string" } }), risk: "write",
          binding: { kind: "route", method: "PUT", path: "/api/blob/{rest}", argsIn: "body" } },
        { name: "host_things_list", description: "GET /api/things", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "GET", path: "/api/things", argsIn: "query" } },
        { name: "host_things_create", description: "POST /api/things", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "POST", path: "/api/things", argsIn: "body" } },
        { name: "host_things_update", description: "PUT /api/things/{id}", inputSchema: blankInput({ id: { type: "string" } }), risk: "write",
          binding: { kind: "route", method: "PUT", path: "/api/things/{id}", argsIn: "body" } },
      ],
      warnings: [],
    });
  });
});

describe("pages route verb evidence", () => {
  it("reads req.method comparisons, switch cases, and Allow headers", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "pages/api/compare.ts",
      "export default function handler(req: any, res: any) { if (req.method !== \"PUT\") return res.status(405).end(); res.end(); }\n",
    );
    await write(
      root,
      "pages/api/switch.ts",
      "export default function handler(req: any, res: any) { switch (req.method) { case \"GET\": return res.end(); case \"DELETE\": return res.end(); default: return res.status(405).end(); } }\n",
    );
    await write(
      root,
      "pages/api/allow-array.ts",
      "export default function handler(req: any, res: any) { res.setHeader(\"Allow\", [\"GET\", \"POST\"]); res.end(); }\n",
    );
    await write(
      root,
      "pages/api/allow-string.ts",
      "export default function handler(req: any, res: any) { res.setHeader(\"Allow\", \"GET, PATCH\"); res.end(); }\n",
    );

    expect(await methodsFor(root, "/api/compare")).toEqual(["PUT"]);
    expect(await methodsFor(root, "/api/switch")).toEqual(["DELETE", "GET"]);
    expect(await methodsFor(root, "/api/allow-array")).toEqual(["GET", "POST"]);
    expect(await methodsFor(root, "/api/allow-string")).toEqual(["GET", "PATCH"]);

    expect(await scanRoutes(root)).toEqual({
      tools: [
        { name: "host_allow_array_list", description: "GET /api/allow-array", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "GET", path: "/api/allow-array", argsIn: "query" } },
        { name: "host_allow_array_create", description: "POST /api/allow-array", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "POST", path: "/api/allow-array", argsIn: "body" } },
        { name: "host_allow_string_list", description: "GET /api/allow-string", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "GET", path: "/api/allow-string", argsIn: "query" } },
        { name: "host_allow_string_update", description: "PATCH /api/allow-string", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "PATCH", path: "/api/allow-string", argsIn: "body" } },
        { name: "host_compare_update", description: "PUT /api/compare", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "PUT", path: "/api/compare", argsIn: "body" } },
        { name: "host_switch_list", description: "GET /api/switch", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "GET", path: "/api/switch", argsIn: "query" } },
        { name: "host_switch_delete", description: "DELETE /api/switch", inputSchema: blankInput(), risk: "destructive",
          binding: { kind: "route", method: "DELETE", path: "/api/switch", argsIn: "query" } },
      ],
      warnings: [],
    });
  });

  it("treats a NextAuth handler as GET+POST", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "pages/api/auth/[...nextauth].ts",
      "import NextAuth from \"next-auth\";\nexport default NextAuth({ providers: [] });\n",
    );
    expect(await methodsFor(root, "/api/auth/{nextauth}")).toEqual(["GET", "POST"]);

    expect(await scanRoutes(root)).toEqual({
      tools: [
        { name: "host_auth_get", description: "GET /api/auth/{nextauth}", inputSchema: blankInput({ nextauth: { type: "string" } }), risk: "write",
          binding: { kind: "route", method: "GET", path: "/api/auth/{nextauth}", argsIn: "query" } },
        { name: "host_auth_create", description: "POST /api/auth/{nextauth}", inputSchema: blankInput({ nextauth: { type: "string" } }), risk: "write",
          binding: { kind: "route", method: "POST", path: "/api/auth/{nextauth}", argsIn: "body" } },
      ],
      warnings: [],
    });
  });

  it("follows a req/res delegate call into the imported handler", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "lib/impl.ts",
      "export default function impl(req: any, res: any) { if (req.method === \"POST\") return res.end(); res.status(405).end(); }\n",
    );
    await write(
      root,
      "pages/api/delegate.ts",
      "import impl from \"../../lib/impl\";\nexport default function handler(req: any, res: any) { return impl(req, res); }\n",
    );
    expect(await methodsFor(root, "/api/delegate")).toEqual(["POST"]);

    expect(await scanRoutes(root)).toEqual({
      tools: [
        { name: "host_delegate_create", description: "POST /api/delegate", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "POST", path: "/api/delegate", argsIn: "body" } },
      ],
      warnings: [],
    });
  });

  it("follows an imported default re-export into the implementing module", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "lib/impl.ts",
      "export default function impl(req: any, res: any) { if (req.method === \"DELETE\") return res.end(); res.status(405).end(); }\n",
    );
    await write(root, "pages/api/re-exported.ts", "import impl from \"../../lib/impl\";\nexport default impl;\n");
    expect(await methodsFor(root, "/api/re-exported")).toEqual(["DELETE"]);

    expect(await scanRoutes(root)).toEqual({
      tools: [
        { name: "host_re_exported_delete", description: "DELETE /api/re-exported", inputSchema: blankInput(), risk: "destructive",
          binding: { kind: "route", method: "DELETE", path: "/api/re-exported", argsIn: "query" } },
      ],
      warnings: [],
    });
  });

  it("infers verbs for method-blind default handlers", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "pages/api/trpc-page.ts",
      "import { createNextApiHandler } from \"@trpc/server/adapters/next\";\nexport default createNextApiHandler({});\n",
    );
    await write(
      root,
      "pages/api/upload.ts",
      "export default async function handler(req: any, res: any) { const body = req.body; res.status(201).json({ body }); }\n",
    );
    await write(
      root,
      "pages/api/stripe/webhook.ts",
      "export default async function handler(_req: any, res: any) { res.end(); }\n",
    );
    await write(
      root,
      "pages/api/raw.ts",
      "export const config = { api: { bodyParser: false } };\nexport default async function handler(_req: any, res: any) { res.end(); }\n",
    );

    expect(await methodsFor(root, "/api/trpc-page")).toEqual(["GET", "POST"]);
    expect(await methodsFor(root, "/api/upload")).toEqual(["POST"]);
    expect(await methodsFor(root, "/api/stripe/webhook")).toEqual(["POST"]);
    expect(await methodsFor(root, "/api/raw")).toEqual(["POST"]);

    expect(await scanRoutes(root)).toEqual({
      tools: [
        { name: "host_raw_create", description: "POST /api/raw", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "POST", path: "/api/raw", argsIn: "body" } },
        { name: "host_stripe_webhook_create", description: "POST /api/stripe/webhook", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "POST", path: "/api/stripe/webhook", argsIn: "body" } },
        { name: "host_trpc_page_list", description: "GET /api/trpc-page", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "GET", path: "/api/trpc-page", argsIn: "query" } },
        { name: "host_trpc_page_create", description: "POST /api/trpc-page", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "POST", path: "/api/trpc-page", argsIn: "body" } },
        { name: "host_upload_create", description: "POST /api/upload", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "POST", path: "/api/upload", argsIn: "body" } },
      ],
      warnings: [],
    });
  });

  it("treats an evidence-less default-export pages handler as GET (papermark health.ts shape)", async () => {
    const root = await temporaryRoot();
    // Real shape from papermark's pages/api/health.ts: plain default export,
    // no req.method branch, no req.body read, no other verb evidence at all.
    await write(
      root,
      "pages/api/health.ts",
      [
        "import type { NextApiRequest, NextApiResponse } from \"next\";",
        "import prisma from \"@/lib/prisma\";",
        "export default async function handler(_req: NextApiRequest, res: NextApiResponse) {",
        "  try {",
        "    await prisma.$queryRaw`SELECT 1`;",
        "    return res.json({ status: \"ok\", message: \"All systems operational\" });",
        "  } catch (err) {",
        "    return res.status(500).json({ status: \"error\", message: (err as Error).message });",
        "  }",
        "}",
      ].join("\n"),
    );
    // Real shape from papermark's pages/api/teams/[teamId]/documents/document-processing-status.ts:
    // reads req.query (not req.method, not req.body) and still has zero
    // method-discriminating evidence.
    await write(
      root,
      "pages/api/teams/[teamId]/documents/status.ts",
      [
        "import { NextApiRequest, NextApiResponse } from \"next\";",
        "import prisma from \"@/lib/prisma\";",
        "export default async function handler(req: NextApiRequest, res: NextApiResponse) {",
        "  const { documentVersionId } = req.query as { documentVersionId: string };",
        "  const documentVersion = await prisma.documentVersion.findUnique({ where: { id: documentVersionId } });",
        "  if (!documentVersion) return res.status(404).end();",
        "  res.status(200).json({ ok: true });",
        "}",
      ].join("\n"),
    );

    expect(await methodsFor(root, "/api/health")).toEqual(["GET"]);
    expect(await methodsFor(root, "/api/teams/{teamId}/documents/status")).toEqual(["GET"]);

    expect(await scanRoutes(root)).toEqual({
      tools: [
        { name: "host_health_list", description: "GET /api/health", inputSchema: blankInput(), risk: "write",
          binding: { kind: "route", method: "GET", path: "/api/health", argsIn: "query" } },
        { name: "host_teams_documents_status_list", description: "GET /api/teams/{teamId}/documents/status",
          inputSchema: blankInput({ teamId: { type: "string" } }), risk: "write",
          binding: { kind: "route", method: "GET", path: "/api/teams/{teamId}/documents/status", argsIn: "query" } },
      ],
      warnings: [],
    });
  });

  it("emits an unclassified disabled tool when no evidence exists", async () => {
    const root = await temporaryRoot();
    await write(root, "pages/api/opaque.ts", "const helper = () => null;\nexport const settings = { helper };\n");
    const { tools, warnings } = await scanRoutes(root);
    expect(tools).toEqual([expect.objectContaining({
      name: "host_opaque_unclassified",
      disabled: true,
      risk: "destructive",
      binding: expect.objectContaining({ method: "POST", path: "/api/opaque" }),
    })]);
    expect(warnings).toEqual([expect.stringContaining("/api/opaque")]);

    expect(await scanRoutes(root)).toEqual({
      tools: [{
        name: "host_opaque_unclassified",
        description: "Route /api/opaque could not be classified",
        inputSchema: { type: "object", properties: {} },
        risk: "destructive",
        disabled: true,
        note: "pages handler has no supported HTTP method evidence; enable only after review; overrides.json can flip disabled/risk",
        binding: { kind: "route", method: "POST", path: "/api/opaque", argsIn: "body" },
      }],
      warnings: ["route /api/opaque could not be classified: pages handler has no supported HTTP method evidence"],
    });
  });
});
