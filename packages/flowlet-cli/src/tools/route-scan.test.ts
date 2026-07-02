import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanRoutes } from "./route-scan.js";
import { textModel } from "../test-helpers.js";

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
  name: "list_transactions",
  description: "List recent transactions with an optional limit.",
  method: "get",
  path: "/api/transactions",
  inputSchema: { type: "object", properties: { limit: { type: "integer", description: "Max rows (default 40)" } } },
}]);

describe("scanRoutes", () => {
  it("finds route.ts files and converts LLM output to fail-closed tool entries", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/api/transactions"), { recursive: true });
    await writeFile(path.join(dir, "src/app/api/transactions/route.ts"), ROUTE);
    const { tools, warnings } = await scanRoutes(dir, textModel([LLM_REPLY]));
    expect(tools).toHaveLength(1);
    expect(warnings).toEqual([]);
    expect(tools[0]).toMatchObject({
      name: "list_transactions",
      binding: { type: "http", method: "GET", path: "/api/transactions" },
      // route-scan tools NEVER auto-allow: the surface is LLM-read code
      annotations: { mutating: true, dangerous: false },
    });
  });

  it("drops entries whose method is not actually exported by the handler", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/api/transactions"), { recursive: true });
    await writeFile(path.join(dir, "src/app/api/transactions/route.ts"), ROUTE); // exports GET only
    const lied = JSON.stringify([
      { name: "delete_transactions", description: "x", method: "delete", path: "/api/transactions", inputSchema: {} },
    ]);
    const { tools, warnings } = await scanRoutes(dir, textModel([lied]));
    expect(tools).toEqual([]);
    expect(warnings[0]).toMatch(/does not export DELETE/);
  });

  it("drops entries whose path matches no route file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/api/transactions"), { recursive: true });
    await writeFile(path.join(dir, "src/app/api/transactions/route.ts"), ROUTE);
    const invented = JSON.stringify([
      { name: "list_admin", description: "x", method: "get", path: "/api/admin", inputSchema: {} },
    ]);
    const { tools, warnings } = await scanRoutes(dir, textModel([invented]));
    expect(tools).toEqual([]);
    expect(warnings[0]).toMatch(/no route file matches/);
  });

  it("returns no tools when there are no route files (no LLM call)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    const { tools } = await scanRoutes(dir, textModel(["[]"]));
    expect(tools).toEqual([]);
  });
});
