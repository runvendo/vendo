import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { Tool, noopObserve } from "@mastra/core/tools";
import type { ExtractedTool } from "@vendoai/actions";
import {
  VENDO_TOOLS_FORMAT,
  VendoError,
  parseVendoToolEnvelope,
  vendoApprovalRefSchema,
  type Principal,
} from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VENDO_PRINCIPAL_KEY, VENDO_SESSION_KEY, vendoMastraTools } from "./mastra.js";
import { createVendo, type Vendo } from "./server.js";

// Wave 1 Lane A — the `@vendoai/vendo/mastra` subpath shim: the BYO tool pack
// in Mastra createTool shape for a STATIC Agent({ tools }) map, with the
// principal (and optional session id) resolved lazily PER CALL from Mastra's
// request context — a static agent definition spans users, so nothing
// principal-scoped may bind at build time.

const principal: Principal = { kind: "user", subject: "user_mastra" };

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

function contextFor(subject: string | undefined, sessionId?: string): { requestContext: RequestContext; observe: typeof noopObserve } {
  const requestContext = new RequestContext();
  if (subject !== undefined) {
    requestContext.set(VENDO_PRINCIPAL_KEY, { kind: "user", subject });
  }
  if (sessionId !== undefined) {
    requestContext.set(VENDO_SESSION_KEY, sessionId);
  }
  return { requestContext, observe: noopObserve };
}

async function compose(): Promise<{ vendo: Vendo; fetchSpy: ReturnType<typeof vi.fn> }> {
  const root = await mkdtemp(join(tmpdir(), "vendo-mastra-root-"));
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-mastra-store-"));
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

describe("@vendoai/vendo/mastra — vendoMastraTools", () => {
  it("returns the pack as Mastra createTool shapes keyed by final name", async () => {
    const { vendo } = await compose();
    const tools = await vendoMastraTools(vendo);
    const names = Object.keys(tools).sort();
    expect(names).toContain("vendo_host_list");
    expect(names).toContain("vendo_host_send");
    expect(names).toContain("vendo_create_app");
    expect(names).toContain("vendo_delegate");
    expect(names.some((name) => name.startsWith("vendo_vendo_"))).toBe(false);
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool).toBeInstanceOf(Tool);
      expect(tool.id).toBe(name);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("passes include/exclude through on final namespaced names", async () => {
    const { vendo } = await compose();
    const tools = await vendoMastraTools(vendo, {
      include: ["vendo_host_list", "vendo_host_send"],
      exclude: ["vendo_host_send"],
    });
    expect(Object.keys(tools)).toEqual(["vendo_host_list"]);
  });

  it("a clean call resolves its principal from the request context and returns plain data", async () => {
    const { vendo, fetchSpy } = await compose();
    const tools = await vendoMastraTools(vendo);
    const output = await tools["vendo_host_list"]!.execute!({}, contextFor("user_mastra"));
    expect(output).toEqual({ ok: true });
    expect(parseVendoToolEnvelope(output)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("an ask-policy call parks under the CALL's principal and returns the envelope", async () => {
    const { vendo, fetchSpy } = await compose();
    const tools = await vendoMastraTools(vendo);
    const output = await tools["vendo_host_send"]!.execute!(
      { body: "hello" },
      contextFor("user_mastra", "session_host_123"),
    );
    const envelope = vendoApprovalRefSchema.parse(output);
    expect(fetchSpy).not.toHaveBeenCalled();
    const pending = await vendo.guard.approvals.pending(principal);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(envelope.approvalId);
    expect(pending[0]!.ctx).toMatchObject({ principal, venue: "chat", presence: "present" });
  });

  it("resolves the principal lazily PER CALL: one static pack serves two users", async () => {
    const { vendo } = await compose();
    const tools = await vendoMastraTools(vendo);
    await tools["vendo_host_send"]!.execute!({}, contextFor("user_a"));
    await tools["vendo_host_send"]!.execute!({}, contextFor("user_b"));
    expect(await vendo.guard.approvals.pending({ kind: "user", subject: "user_a" })).toHaveLength(1);
    expect(await vendo.guard.approvals.pending({ kind: "user", subject: "user_b" })).toHaveLength(1);
  });

  it("a call without a principal in the request context fails closed, naming the key", async () => {
    const { vendo, fetchSpy } = await compose();
    const tools = await vendoMastraTools(vendo);
    await expect(
      tools["vendo_host_list"]!.execute!({}, contextFor(undefined)),
    ).rejects.toThrowError(VendoError);
    await expect(
      tools["vendo_host_list"]!.execute!({}, contextFor(undefined)),
    ).rejects.toThrowError(new RegExp(VENDO_PRINCIPAL_KEY));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// 0.4.x E2E (report-mastra defect 5) — Mastra's provider schema-compat layers
// hard-close every object schema for strict-mode providers (the OpenAI layer
// sets additionalProperties:false on all of them), so an OPEN extracted tool
// input ({type:"object", properties:{}, additionalProperties:true}) reached
// the model as "takes no arguments" and every call — including one whose args
// the user dictated verbatim — executed (and parked, and replayed after
// approval) with {}. The shim now bridges open inputs through one declared
// JSON-string `args` property and unwraps it before the guard.
describe("@vendoai/vendo/mastra — open-schema args bridge", () => {
  const dictated = { id: "chat_1", messages: [{ role: "user", content: "hello" }] };

  it("unwraps the advertised JSON-string form into the parked call's args", async () => {
    const { vendo, fetchSpy } = await compose();
    const tools = await vendoMastraTools(vendo);
    const output = await tools["vendo_host_send"]!.execute!(
      { args: JSON.stringify(dictated) },
      contextFor("user_mastra"),
    );
    vendoApprovalRefSchema.parse(output);
    expect(fetchSpy).not.toHaveBeenCalled();
    const pending = await vendo.guard.approvals.pending(principal);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.call.args).toEqual(dictated);
  });

  it("accepts a plain-object args (a model that skipped the string encoding) and a raw payload (a provider that ignored the bridge)", async () => {
    const { vendo } = await compose();
    const tools = await vendoMastraTools(vendo);
    await tools["vendo_host_send"]!.execute!({ args: dictated }, contextFor("user_a"));
    await tools["vendo_host_send"]!.execute!(dictated, contextFor("user_b"));
    const [a] = await vendo.guard.approvals.pending({ kind: "user", subject: "user_a" });
    const [b] = await vendo.guard.approvals.pending({ kind: "user", subject: "user_b" });
    expect(a!.call.args).toEqual(dictated);
    expect(b!.call.args).toEqual(dictated);
  });

  it("treats a missing/empty args as {} and fails closed on unparseable JSON", async () => {
    const { vendo, fetchSpy } = await compose();
    const tools = await vendoMastraTools(vendo);
    const output = await tools["vendo_host_list"]!.execute!({ args: "" }, contextFor("user_mastra"));
    expect(output).toEqual({ ok: true });
    const [, options] = fetchSpy.mock.calls[0] as [unknown, { method?: string } | undefined];
    expect(options?.method ?? "GET").toBe("GET");
    await expect(
      tools["vendo_host_send"]!.execute!({ args: "{not json" }, contextFor("user_mastra")),
    ).rejects.toThrowError(VendoError);
  });

  it("a REAL Mastra agent turn on an OpenAI-identified model advertises the bridge and parks the dictated args intact", async () => {
    const { vendo } = await compose();
    // A deterministic v2-spec model wearing OpenAI identity, so Mastra applies
    // its OpenAI schema-compat layer — the exact transform that flattened open
    // schemas to "no arguments" in the live lane.
    let sawToolSchema: Record<string, unknown> | undefined;
    let calls = 0;
    const model = {
      specificationVersion: "v2",
      provider: "openai.chat",
      modelId: "gpt-4.1-mini",
      supportedUrls: {},
      async doGenerate(options: { tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }> }) {
        sawToolSchema ??= options.tools?.find((tool) => tool.name === "vendo_host_send")?.inputSchema;
        calls += 1;
        if (calls > 1) {
          return {
            content: [{ type: "text", text: "done" }],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        }
        return {
          content: [{
            type: "tool-call",
            toolCallId: `call_${calls}`,
            toolName: "vendo_host_send",
            input: JSON.stringify({ args: JSON.stringify(dictated) }),
          }],
          finishReason: "tool-calls",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
      async doStream() {
        throw new Error("doStream not scripted");
      },
    } as unknown as LanguageModel;
    const agent = new Agent({
      id: "bridge-agent",
      name: "Bridge Agent",
      instructions: "Call vendo_host_send with the dictated args.",
      model,
      tools: async () => vendoMastraTools(vendo),
    });
    const requestContext = new RequestContext();
    requestContext.set(VENDO_PRINCIPAL_KEY, principal);
    await agent.generate("send it", { requestContext });
    // The model-facing schema must DECLARE the bridge property — an open
    // object here would have been closed to additionalProperties:false with
    // zero properties (the defect).
    const properties = sawToolSchema?.properties as Record<string, unknown> | undefined;
    expect(properties?.args).toBeDefined();
    const pending = await vendo.guard.approvals.pending(principal);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.call.args).toEqual(dictated);
  });
});
