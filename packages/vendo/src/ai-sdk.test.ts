import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractedTool } from "@vendoai/actions";
import {
  VENDO_TOOLS_FORMAT,
  VendoError,
  parseVendoToolEnvelope,
  vendoApprovalRefSchema,
  type Principal,
} from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel, Tool, ToolCallOptions } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vendoTools } from "./ai-sdk.js";
import { createVendo, type Vendo } from "./server.js";

// Wave 1 Lane A — the `@vendoai/vendo/ai-sdk` subpath shim: the BYO tool pack
// in AI SDK ToolSet shape, built per request with a principal, over the REAL
// createVendo composition (same guard binding chat/apps/automations use).

const principal: Principal = { kind: "user", subject: "user_ai_sdk" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function routeTool(name: string, extras: Partial<ExtractedTool> = {}): ExtractedTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object" },
    risk: "read",
    binding: { kind: "route", method: "GET", path: `/${name}`, argsIn: "query" },
    ...extras,
  };
}

const callOptions = (toolCallId: string): ToolCallOptions => ({ toolCallId, messages: [] });

async function compose(): Promise<{ vendo: Vendo; fetchSpy: ReturnType<typeof vi.fn> }> {
  const root = await mkdtemp(join(tmpdir(), "vendo-ai-sdk-root-"));
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-ai-sdk-store-"));
  const previousCwd = process.cwd();
  cleanups.push(async () => {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
  await mkdir(join(root, ".vendo"));
  await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
    format: VENDO_TOOLS_FORMAT,
    tools: [
      routeTool("host_list"),
      routeTool("host_send", {
        risk: "write",
        binding: { kind: "route", method: "POST", path: "/host_send", argsIn: "body" },
      }),
    ],
  }));
  vi.stubEnv("VENDO_BASE_URL", "https://host.test");
  const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchSpy);
  process.chdir(root);
  const store = createStore({ dataDir });
  cleanups.push(async () => { await store.close(); });
  await store.ensureSchema();
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    policy: { rules: [{ match: { tool: "host_send" }, action: "ask" }] },
  });
  return { vendo, fetchSpy };
}

describe("@vendoai/vendo/ai-sdk — vendoTools", () => {
  it("returns the pack as an AI SDK ToolSet: namespaced host tools plus the built-ins", async () => {
    const { vendo } = await compose();
    const tools = await vendoTools(vendo, { principal });
    const names = Object.keys(tools).sort();
    expect(names).toContain("vendo_host_list");
    expect(names).toContain("vendo_host_send");
    expect(names).toContain("vendo_create_app");
    expect(names).toContain("vendo_delegate");
    expect(names.some((name) => name.startsWith("vendo_vendo_"))).toBe(false);
    for (const tool of Object.values(tools) as Tool[]) {
      expect(tool.type).toBe("dynamic");
      expect(typeof tool.execute).toBe("function");
      expect(tool.description!.length).toBeGreaterThan(0);
    }
  });

  it("passes include/exclude through on final namespaced names", async () => {
    const { vendo } = await compose();
    const tools = await vendoTools(vendo, {
      principal,
      include: ["vendo_host_list", "vendo_host_send"],
      exclude: ["vendo_host_send"],
    });
    expect(Object.keys(tools)).toEqual(["vendo_host_list"]);
  });

  it("a clean call executes through the wire binding and returns plain data", async () => {
    const { vendo, fetchSpy } = await compose();
    const tools = await vendoTools(vendo, { principal });
    const output = await tools["vendo_host_list"]!.execute!({}, callOptions("call_list"));
    expect(output).toEqual({ ok: true });
    expect(parseVendoToolEnvelope(output)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("an ask-policy call parks with the REQUEST's principal and chat/present context, returning the envelope", async () => {
    const { vendo, fetchSpy } = await compose();
    const tools = await vendoTools(vendo, { principal });
    const output = await tools["vendo_host_send"]!.execute!(
      { body: "hello" },
      callOptions("call_send"),
    );
    const envelope = vendoApprovalRefSchema.parse(output);
    expect(fetchSpy).not.toHaveBeenCalled();
    const pending = await vendo.guard.approvals.pending(principal);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(envelope.approvalId);
    expect(pending[0]!.ctx).toMatchObject({ principal, venue: "chat", presence: "present" });
  });

  it("is per-request: a second pack built for another principal parks under that principal", async () => {
    const { vendo } = await compose();
    const other: Principal = { kind: "user", subject: "user_other" };
    const tools = await vendoTools(vendo, { principal: other });
    await tools["vendo_host_send"]!.execute!({}, callOptions("call_other"));
    expect(await vendo.guard.approvals.pending(other)).toHaveLength(1);
    expect(await vendo.guard.approvals.pending(principal)).toHaveLength(0);
  });

  it("refuses to build a pack without a principal", async () => {
    const { vendo } = await compose();
    await expect(
      vendoTools(vendo, { principal: undefined as unknown as Principal }),
    ).rejects.toThrowError(VendoError);
  });
});
