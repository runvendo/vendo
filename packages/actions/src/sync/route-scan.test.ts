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

describe("app route verb evidence", () => {
  it("reads exported declarations, declaration lists, and destructured exports", async () => {
    const root = await temporaryRoot();
    await write(root, "app/api/fn/route.ts", "export async function GET() { return new Response(); }\n");
    await write(root, "app/api/list/route.ts", "const handler = () => new Response();\nexport const runtime = \"edge\", POST = handler;\n");
    await write(root, "app/api/pair/route.ts", "const handlers = { GET: () => null, PUT: () => null };\nexport const { GET, PUT } = handlers;\n");

    expect(await methodsFor(root, "/api/fn")).toEqual(["GET"]);
    expect(await methodsFor(root, "/api/list")).toEqual(["POST"]);
    expect(await methodsFor(root, "/api/pair")).toEqual(["GET", "PUT"]);
  });

  it("reads local aliased export lists and ignores non-verb names", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "app/api/aliased/route.ts",
      "async function handle() { return new Response(); }\nexport { handle as PATCH, handle as helper };\n",
    );
    expect(await methodsFor(root, "/api/aliased")).toEqual(["PATCH"]);
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
  });

  it("ignores verb-looking text inside strings and comments", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "app/api/noise/route.ts",
      "// export function GET() {}\nconst usage = \"export function POST\";\nexport function PUT() { return new Response(usage); }\n",
    );
    expect(await methodsFor(root, "/api/noise")).toEqual(["PUT"]);
  });

  it("classifies a defaultHandler verb-keyed object argument", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "app/api/keyed/route.ts",
      "import { defaultHandler } from \"../../../lib/router\";\nconst run = defaultHandler({ GET: () => null, \"POST\": () => null, other: () => null });\nexport default run;\n",
    );
    expect(await methodsFor(root, "/api/keyed")).toEqual(["GET", "POST"]);
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
  });

  it("treats a NextAuth handler as GET+POST", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "pages/api/auth/[...nextauth].ts",
      "import NextAuth from \"next-auth\";\nexport default NextAuth({ providers: [] });\n",
    );
    expect(await methodsFor(root, "/api/auth/{nextauth}")).toEqual(["GET", "POST"]);
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
  });
});
