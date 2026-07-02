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
  it("finds route.ts files and converts LLM output to tool entries", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/api/transactions"), { recursive: true });
    await writeFile(path.join(dir, "src/app/api/transactions/route.ts"), ROUTE);
    const tools = await scanRoutes(dir, textModel([LLM_REPLY]));
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "list_transactions",
      source: "route-scan",
      http: { method: "get", path: "/api/transactions" },
      annotations: { readOnlyHint: true, openWorldHint: false },
    });
  });

  it("returns [] when there are no route files (no LLM call)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    const tools = await scanRoutes(dir, textModel(["[]"]));
    expect(tools).toEqual([]);
  });
});
