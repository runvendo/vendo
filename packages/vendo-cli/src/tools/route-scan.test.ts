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
  it("finds route.ts files, uses deterministic names, and keeps GET read-only", async () => {
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
      annotations: { mutating: false, dangerous: false },
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
      ["getAuthNextauth", "GET", "/api/auth/{nextauth}", false],
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
      ["getUploadthing", "GET", false],
      ["postUploadthing", "POST", true],
    ]);
  });
});
