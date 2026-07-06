import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { scanRoutes } from "./route-scan.js";
import { textModel } from "../test-helpers.js";

const ZERO_USAGE: LanguageModelV3GenerateResult["usage"] = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** A mock model that records the raw call options it was invoked with (to inspect the prompt actually sent). */
function capturingModel(reply: string): { model: MockLanguageModelV3; calls: unknown[] } {
  const calls: unknown[] = [];
  const doGenerate = vi.fn(async (options: unknown): Promise<LanguageModelV3GenerateResult> => {
    calls.push(options);
    return {
      content: [{ type: "text", text: reply }],
      finishReason: { unified: "stop", raw: undefined },
      usage: ZERO_USAGE,
      warnings: [],
    };
  });
  return { model: new MockLanguageModelV3({ doGenerate }), calls };
}

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
    expect(tools[0]).toMatchObject({ name: "list_transactions" });
    // No mention of the vendo route at all — it must never reach the LLM prompt or warnings.
    expect(warnings).toEqual([]);
    expect(warnings.join("\n")).not.toMatch(/vendo/i);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).not.toMatch(/createVendoHandler/);
  });

  it("also excludes the Vendo route when the app dir has no src/ prefix", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "app/api/vendo/[...path]"), { recursive: true });
    await writeFile(
      path.join(dir, "app/api/vendo/[...path]/route.ts"),
      `export const { GET, POST } = createVendoHandler();\n`,
    );
    const { tools, warnings } = await scanRoutes(dir, textModel(["[]"]));
    expect(tools).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("does not exclude a legitimately named route like api/vendors", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "routes-"));
    await mkdir(path.join(dir, "src/app/api/vendors"), { recursive: true });
    await writeFile(path.join(dir, "src/app/api/vendors/route.ts"), ROUTE);
    const vendorsReply = JSON.stringify([{
      name: "list_vendors",
      description: "List vendors.",
      method: "get",
      path: "/api/vendors",
      inputSchema: { type: "object", properties: {} },
    }]);
    const { tools, warnings } = await scanRoutes(dir, textModel([vendorsReply]));
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "list_vendors" });
    expect(warnings).toEqual([]);
  });
});
