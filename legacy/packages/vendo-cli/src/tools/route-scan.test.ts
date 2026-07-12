import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanRoutes } from "./route-scan.js";
import { capturingModel, textModel } from "../test-helpers.js";

const ROUTE = `
import { ok } from "@/server/http";
import { listTransactions } from "@/server/transactions";
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 40);
  return ok(listTransactions({ limit }));
}
`;

const LLM_REPLY = JSON.stringify([{
  name: "getTransactions",
  description: "List recent transactions with an optional limit.",
  method: "get",
  path: "/api/transactions",
  inputSchema: { type: "object", properties: { limit: { type: "integer", description: "Max rows (default 40)" } } },
}]);

describe("scanRoutes", () => {
  it("finds route.ts files, uses deterministic names, and keeps route-scan GETs fail-closed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/api/transactions"), { recursive: true });
    await writeFile(path.join(dir, "src/app/api/transactions/route.ts"), ROUTE);
    const { tools, warnings } = await scanRoutes(dir, textModel([LLM_REPLY]));
    expect(tools).toHaveLength(1);
    expect(warnings).toEqual([]);
    expect(tools[0]).toMatchObject({
      name: "getTransactions",
      description: "List recent transactions with an optional limit.",
      binding: { type: "http", method: "GET", path: "/api/transactions" },
      annotations: { mutating: true, dangerous: false },
    });
  });

  it("keeps deterministic inventory when the LLM invents a method", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/api/transactions"), { recursive: true });
    await writeFile(path.join(dir, "src/app/api/transactions/route.ts"), ROUTE); // exports GET only
    const lied = JSON.stringify([
      { name: "delete_transactions", description: "x", method: "delete", path: "/api/transactions", inputSchema: {} },
    ]);
    const { tools, warnings } = await scanRoutes(dir, textModel([lied]));
    expect(tools.map((tool) => tool.name)).toEqual(["getTransactions"]);
    expect(warnings[0]).toMatch(/does not export DELETE/);
  });

  it("keeps deterministic inventory when the LLM invents a path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/api/transactions"), { recursive: true });
    await writeFile(path.join(dir, "src/app/api/transactions/route.ts"), ROUTE);
    const invented = JSON.stringify([
      { name: "list_admin", description: "x", method: "get", path: "/api/admin", inputSchema: {} },
    ]);
    const { tools, warnings } = await scanRoutes(dir, textModel([invented]));
    expect(tools.map((tool) => tool.name)).toEqual(["getTransactions"]);
    expect(warnings[0]).toMatch(/no route file matches/);
  });

  it("detects multiple HTTP verb declarators in one exported const statement", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/api/coexport"), { recursive: true });
    await writeFile(
      path.join(dir, "src/app/api/coexport/route.ts"),
      `const handler = () => Response.json({ ok: true });\nexport const GET = handler, POST = handler;\n`,
    );

    const { tools, warnings } = await scanRoutes(dir, null);

    expect(warnings).toEqual([]);
    expect(tools.map((tool) => [tool.name, tool.binding.method, tool.binding.path, tool.annotations.mutating])).toEqual([
      ["getCoexport", "GET", "/api/coexport", true],
      ["postCoexport", "POST", "/api/coexport", true],
    ]);
  });

  it("ignores non-HTTP names in a multi-declarator exported const statement", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/api/mixed"), { recursive: true });
    await writeFile(
      path.join(dir, "src/app/api/mixed/route.ts"),
      `const handler = () => Response.json({ ok: true });\nexport const GET = handler, options = handler, PATCH = handler;\n`,
    );

    const { tools, warnings } = await scanRoutes(dir, null);

    expect(warnings).toEqual([]);
    expect(tools.map((tool) => [tool.name, tool.binding.method, tool.binding.path, tool.annotations.mutating])).toEqual([
      ["getMixed", "GET", "/api/mixed", true],
      ["patchMixed", "PATCH", "/api/mixed", true],
    ]);
  });

  it("discovers App Router routes under route groups and strips the groups from the URL path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "app/(internal)/api/widgets"), { recursive: true });
    await writeFile(
      path.join(dir, "app/(internal)/api/widgets/route.ts"),
      `export async function GET() { return Response.json([]); }\n`,
    );

    const { tools, warnings } = await scanRoutes(dir, null);

    expect(warnings).toEqual([]);
    expect(tools.map((tool) => [tool.name, tool.binding.method, tool.binding.path, tool.annotations.mutating])).toEqual([
      ["getWidgets", "GET", "/api/widgets", true],
    ]);
  });

  it("discovers nested route-group-only roots and parallel routes with deterministic URL paths", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/(api)/(v1)/bases/[baseId]"), { recursive: true });
    await writeFile(
      path.join(dir, "src/app/(api)/(v1)/bases/[baseId]/route.ts"),
      `export async function PATCH() { return Response.json({ ok: true }); }\n`,
    );
    await mkdir(path.join(dir, "src/app/@modal/(api)/spaces"), { recursive: true });
    await writeFile(
      path.join(dir, "src/app/@modal/(api)/spaces/route.ts"),
      `export async function POST() { return Response.json({ ok: true }); }\n`,
    );

    const { tools, warnings } = await scanRoutes(dir, null);

    expect(warnings).toEqual([]);
    expect(tools.map((tool) => [tool.name, tool.binding.method, tool.binding.path, tool.annotations.mutating])).toEqual([
      ["patchBasesBaseId", "PATCH", "/bases/{baseId}", true],
      ["postSpaces", "POST", "/spaces", true],
    ]);
  });

  it("does not treat non-API route groups as agent tools", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/(collect)/q/[slug]"), { recursive: true });
    await writeFile(
      path.join(dir, "src/app/(collect)/q/[slug]/route.ts"),
      `export async function GET() { return Response.json({ ok: true }); }\n`,
    );

    const { tools, warnings } = await scanRoutes(dir, null);

    expect(tools).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("returns no tools when there are no route files (no LLM call)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    const { tools } = await scanRoutes(dir, textModel(["[]"]));
    expect(tools).toEqual([]);
  });

  it("excludes Vendo's own generated catch-all route from the scan", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/api/transactions"), { recursive: true });
    await writeFile(path.join(dir, "src/app/api/transactions/route.ts"), ROUTE);
    await mkdir(path.join(dir, "src/app/api/vendo/[...path]"), { recursive: true });
    await writeFile(
      path.join(dir, "src/app/api/vendo/[...path]/route.ts"),
      `import { createVendoHandler } from "vendo/server";\nexport const { GET, POST } = createVendoHandler();\n`,
    );
    const { model, calls } = capturingModel(LLM_REPLY);
    const { tools, warnings } = await scanRoutes(dir, model);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "getTransactions" });
    // No mention of the vendo route at all — it must never reach the LLM prompt or warnings.
    expect(warnings).toEqual([]);
    expect(warnings.join("\n")).not.toMatch(/vendo/i);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).not.toMatch(/createVendoHandler/);
  });

  it("also excludes the Vendo route when the app dir has no src/ prefix", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "app/api/transactions"), { recursive: true });
    await writeFile(path.join(dir, "app/api/transactions/route.ts"), ROUTE);
    await mkdir(path.join(dir, "app/api/vendo/[...path]"), { recursive: true });
    await writeFile(
      path.join(dir, "app/api/vendo/[...path]/route.ts"),
      `export const { GET, POST } = createVendoHandler();\n`,
    );
    const { model, calls } = capturingModel(LLM_REPLY);
    const { tools, warnings } = await scanRoutes(dir, model);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "getTransactions" });
    expect(warnings).toEqual([]);
    // The relPath here is `app/api/vendo/...` with no leading slash: only the
    // `^` branch of the exclusion regex catches it. This pins the anchor.
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).not.toMatch(/createVendoHandler/);
  });

  it("does not exclude a legitimately named route like api/vendors", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/api/vendors"), { recursive: true });
    await writeFile(path.join(dir, "src/app/api/vendors/route.ts"), ROUTE);
    const vendorsReply = JSON.stringify([{
      name: "getVendors",
      description: "List vendors.",
      method: "get",
      path: "/api/vendors",
      inputSchema: { type: "object", properties: {} },
    }]);
    const { tools, warnings } = await scanRoutes(dir, textModel([vendorsReply]));
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "getVendors" });
    expect(warnings).toEqual([]);
  });

  it("falls back to deterministic tools when LLM JSON fails validation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/api/transactions"), { recursive: true });
    await writeFile(path.join(dir, "src/app/api/transactions/route.ts"), ROUTE);
    const { tools, warnings } = await scanRoutes(dir, textModel(["```json\n[", "not json"]));
    expect(tools.map((tool) => tool.name)).toEqual(["getTransactions"]);
    expect(warnings.join("\n")).toMatch(/LLM route enrichment failed/);
  });

  it("discovers pages/api handlers and normalizes catch-all params", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "pages/api/auth"), { recursive: true });
    await writeFile(
      path.join(dir, "pages/api/auth/[...nextauth].ts"),
      `import NextAuth from "next-auth";\nexport default NextAuth({});\n`,
    );
    const { tools, warnings } = await scanRoutes(dir, null);
    expect(warnings).toEqual([]);
    expect(tools.map((tool) => [tool.name, tool.binding.method, tool.binding.path, tool.annotations.mutating])).toEqual([
      ["getAuthNextauth", "GET", "/api/auth/{nextauth}", true],
      ["postAuthNextauth", "POST", "/api/auth/{nextauth}", true],
    ]);
  });

  it("detects destructured app route handler exports", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/api/uploadthing"), { recursive: true });
    await writeFile(
      path.join(dir, "src/app/api/uploadthing/route.ts"),
      `export const { GET, POST } = createRouteHandler({ router });\n`,
    );
    const { tools, warnings } = await scanRoutes(dir, null);
    expect(warnings).toEqual([]);
    expect(tools.map((tool) => [tool.name, tool.binding.method, tool.annotations.mutating])).toEqual([
      ["getUploadthing", "GET", true],
      ["postUploadthing", "POST", true],
    ]);
  });

  it("follows App Router star re-exports and keeps the re-exporting route path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "app/api/projects"), { recursive: true });
    await mkdir(path.join(dir, "app/api/workspaces"), { recursive: true });
    await writeFile(path.join(dir, "app/api/projects/route.ts"), `export * from "../workspaces/route";\n`);
    await writeFile(
      path.join(dir, "app/api/workspaces/route.ts"),
      `export async function GET() { return Response.json([]); }\nexport async function POST() { return Response.json({ ok: true }); }\n`,
    );

    const { tools, warnings } = await scanRoutes(dir, null);

    expect(warnings).toEqual([]);
    expect(tools.map((tool) => [tool.name, tool.binding.method, tool.binding.path])).toEqual([
      ["getProjects", "GET", "/api/projects"],
      ["postProjects", "POST", "/api/projects"],
      ["getWorkspaces", "GET", "/api/workspaces"],
      ["postWorkspaces", "POST", "/api/workspaces"],
    ]);
  });

  it("follows named default re-exports through tsconfig paths for Pages API handlers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await writeFile(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["lib/*"] } } }),
    );
    await mkdir(path.join(dir, "pages/api/auth"), { recursive: true });
    await mkdir(path.join(dir, "lib/pages/auth"), { recursive: true });
    await writeFile(
      path.join(dir, "pages/api/auth/verify-email.ts"),
      `export { handler as default } from "@lib/pages/auth/verify-email";\n`,
    );
    await writeFile(
      path.join(dir, "lib/pages/auth/verify-email.ts"),
      `export async function handler(_req, res) { return res.status(200).json({ ok: true }); }\n`,
    );

    const { tools, warnings } = await scanRoutes(dir, null);

    expect(warnings).toEqual([]);
    expect(tools.map((tool) => [tool.name, tool.binding.method, tool.binding.path])).toEqual([
      ["getAuthVerifyEmail", "GET", "/api/auth/verify-email"],
    ]);
  });

  it("uses defaultHandler method-key maps for Pages API default exports", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "pages/api/apps"), { recursive: true });
    await writeFile(
      path.join(dir, "pages/api/apps/add.ts"),
      `
import defaultHandler from "@calcom/lib/server/defaultHandler";
export default defaultHandler({
  GET: Promise.resolve({ default: getHandler }),
  POST: Promise.resolve({ default: postHandler }),
});
`,
    );

    const { tools, warnings } = await scanRoutes(dir, null);

    expect(warnings).toEqual([]);
    expect(tools.map((tool) => [tool.name, tool.binding.method, tool.binding.path])).toEqual([
      ["getAppsAdd", "GET", "/api/apps/add"],
      ["postAppsAdd", "POST", "/api/apps/add"],
    ]);
  });

  it("treats tRPC Next API handlers as GET and POST endpoints", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "pages/api/trpc/admin"), { recursive: true });
    await writeFile(
      path.join(dir, "pages/api/trpc/admin/[trpc].ts"),
      `
import { createNextApiHandler } from "@calcom/trpc/server/createNextApiHandler";
export default createNextApiHandler(adminRouter);
`,
    );

    const { tools, warnings } = await scanRoutes(dir, null);

    expect(warnings).toEqual([]);
    expect(tools.map((tool) => [tool.name, tool.binding.method, tool.binding.path])).toEqual([
      ["getTrpcAdminTrpc", "GET", "/api/trpc/admin/{trpc}"],
      ["postTrpcAdminTrpc", "POST", "/api/trpc/admin/{trpc}"],
    ]);
  });

  it("infers POST, not GET, for Pages API webhook default handlers without method evidence", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "pages/api/stripe"), { recursive: true });
    await writeFile(
      path.join(dir, "pages/api/stripe/webhook.ts"),
      `
export const config = { api: { bodyParser: false } };
export default function handler(_req, res) {
  res.status(404).json({ message: "webhooks unavailable" });
}
`,
    );

    const { tools, warnings } = await scanRoutes(dir, null);

    expect(warnings).toEqual([]);
    expect(tools.map((tool) => [tool.name, tool.binding.method, tool.binding.path])).toEqual([
      ["postStripeWebhook", "POST", "/api/stripe/webhook"],
    ]);
  });

  it("infers POST for Pages API webhook default re-exports with disabled body parsing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "pages/api/integrations/alby"), { recursive: true });
    await writeFile(
      path.join(dir, "pages/api/integrations/alby/webhook.ts"),
      `
export { default } from "@calcom/app-store/alby/api/webhook";
export const config = { api: { bodyParser: false } };
`,
    );

    const { tools, warnings } = await scanRoutes(dir, null);

    expect(warnings).toEqual([]);
    expect(tools.map((tool) => [tool.name, tool.binding.method, tool.binding.path])).toEqual([
      ["postIntegrationsAlbyWebhook", "POST", "/api/integrations/alby/webhook"],
    ]);
  });

  it("infers POST for dynamic integration handler-map Pages API routes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "pages/api/integrations"), { recursive: true });
    await writeFile(
      path.join(dir, "pages/api/integrations/[...args].ts"),
      `
const handler = async (req, res) => {
  const handlerMap = (await import("@calcom/app-store/apps.server.generated")).apiHandlers;
  const handlers = await handlerMap[String(req.query.args?.[0])];
  const handler = handlers?.[String(req.query.args?.[1])];
  if (typeof handler === "function") await handler(req, res);
};
export default handler;
`,
    );

    const { tools, warnings } = await scanRoutes(dir, null);

    expect(warnings).toEqual([]);
    expect(tools.map((tool) => [tool.name, tool.binding.method, tool.binding.path])).toEqual([
      ["postIntegrationsArgs", "POST", "/api/integrations/{args}"],
    ]);
  });

  it("prefers App Router over Pages API when both map to the same URL path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "app/api/shared"), { recursive: true });
    await writeFile(
      path.join(dir, "app/api/shared/route.ts"),
      `export async function GET() { return Response.json({ source: "app" }); }\n`,
    );
    await mkdir(path.join(dir, "pages/api"), { recursive: true });
    await writeFile(
      path.join(dir, "pages/api/shared.ts"),
      `export default function handler(req, res) { if (req.method === "POST") res.json({ source: "pages" }); }\n`,
    );
    const lied = JSON.stringify([{
      name: "postShared",
      description: "Pages API version.",
      method: "post",
      path: "/api/shared",
      inputSchema: { type: "object", properties: {} },
    }]);

    const { tools, warnings } = await scanRoutes(dir, textModel([lied]));

    expect(tools.map((tool) => [tool.name, tool.binding.method, tool.binding.path])).toEqual([
      ["getShared", "GET", "/api/shared"],
    ]);
    expect(warnings.join("\n")).toMatch(/does not export POST/);
  });
});
