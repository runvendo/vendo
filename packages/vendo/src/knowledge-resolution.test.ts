import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeAdapter, Principal, RunContext, ToolOutcome } from "@vendoai/core";
import { lexicalKnowledge } from "@vendoai/knowledge";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVendo, type CreateVendoConfig, type Vendo } from "./server.js";

/**
 * The knowledge RESOLUTION MATRIX (ENG-368, issue #623).
 *
 * The whole-chain e2e run found a host that sets VENDO_API_KEY — the
 * documented way to get Cloud knowledge — composing NO knowledge adapter, no
 * `vendo_knowledge_search` tool, and no error, while every other Cloud-backed
 * seam resolved from the same key. The seam test that existed asserted only
 * the two combinations that worked, so a unit suite stayed green across a
 * broken product. This file pins every combination instead: which
 * implementation composes, whether the tool appears, and — for the cloud rung
 * — that a real `vendo/knowledge-wire@1` call leaves the process.
 */

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  // The seam reads the key itself; a developer's real key in the ambient env
  // must never decide what this suite observes.
  vi.stubEnv("VENDO_API_KEY", "");
  vi.stubEnv("VENDO_CLOUD_URL", "");
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-knowledge-resolution-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const principal: Principal = { kind: "user", subject: "user_knowledge" };
const ctx: RunContext = { principal, venue: "app", presence: "present", sessionId: "session_knowledge" };

async function compose(config: Partial<CreateVendoConfig> = {}): Promise<Vendo> {
  return createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store: await tempStore(),
    ...config,
  });
}

const hasKnowledgeTool = async (vendo: Vendo): Promise<boolean> =>
  (await vendo.actions.descriptors()).some((descriptor) => descriptor.name === "vendo_knowledge_search");

const search = (vendo: Vendo, query: string): Promise<ToolOutcome> =>
  vendo.actions.execute({ id: "call_knowledge", tool: "vendo_knowledge_search", args: { query } }, ctx);

/** A console mount that speaks the search leg of `vendo/knowledge-wire@1`.
    Deliberately NOT the knowledge package's fake server: the point is to
    observe what the composed adapter puts on the wire — URL, bearer, body —
    from outside the block that builds it. */
function fakeConsole(options: { bearer?: string } = {}): {
  fetch: ReturnType<typeof vi.fn>;
  calls: Array<{ url: string; authorization: string | null }>;
} {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    // Composition touches other console routes (tool overrides, config); only
    // the knowledge wire is this fake's business.
    if (!request.url.includes("/api/v1/knowledge/")) return new Response("not found", { status: 404 });
    calls.push({ url: request.url, authorization: request.headers.get("authorization") });
    if (options.bearer !== undefined && request.headers.get("authorization") !== `Bearer ${options.bearer}`) {
      return Response.json({ error: { code: "unauthorized", message: "Valid API key required." } }, { status: 401 });
    }
    return Response.json({
      hits: [{
        ref: { docId: "doc-cloud", title: "Wire transfers", source: "docs/transfers.md" },
        snippet: "Cloud-hosted answer: transfers settle in one business day.",
        kind: "docs",
        visibility: "public",
        score: 0.9,
      }],
    });
  });
  return { fetch, calls };
}

describe("knowledge resolution — the VENDO_API_KEY cloud rung (#623)", () => {
  it("composes the Cloud engine from the key alone, with no hand-wiring", async () => {
    const mount = fakeConsole();
    vi.stubGlobal("fetch", mount.fetch);
    vi.stubEnv("VENDO_API_KEY", "vnd_key_only");
    vi.stubEnv("VENDO_CLOUD_URL", "https://console.test");

    const vendo = await compose();

    expect(await hasKnowledgeTool(vendo)).toBe(true);

    const outcome = await search(vendo, "how long do transfers take");
    expect(outcome).toMatchObject({
      status: "ok",
      output: { outcome: "answered", hits: [{ docId: "doc-cloud" }] },
    });
    expect(mount.calls[0]?.url).toBe("https://console.test/api/v1/knowledge/search");
    expect(mount.calls[0]?.authorization).toBe("Bearer vnd_key_only");
  });

  it("says a bad key is a bad key instead of a silent shrug", async () => {
    const mount = fakeConsole({ bearer: "vnd_the_real_key" });
    vi.stubGlobal("fetch", mount.fetch);
    vi.stubEnv("VENDO_API_KEY", "vnd_wrong_key");
    vi.stubEnv("VENDO_CLOUD_URL", "https://console.test");
    const warn = vi.spyOn(globalThis.console, "warn").mockImplementation(() => undefined);

    const vendo = await compose();
    const outcome = await search(vendo, "how long do transfers take");

    // The outcome stays the contract's `unavailable` — but the REASON must
    // reach both the model and the operator's logs.
    expect(outcome).toMatchObject({ status: "ok", output: { outcome: "unavailable" } });
    const output = (outcome as { output: { message?: string } }).output;
    expect(output.message).toMatch(/rejected the API key/);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/rejected the API key/);
  });
});

describe("knowledge resolution — the zero-config local rung", () => {
  it("injects the composed store into a store-less lexicalKnowledge()", async () => {
    const store = await tempStore();
    await store.ensureSchema();

    const vendo = await compose({ store, knowledge: lexicalKnowledge() });

    expect(await hasKnowledgeTool(vendo)).toBe(true);
    const seeded = lexicalKnowledge({ store }) as Required<Pick<KnowledgeAdapter, "upsert">> & KnowledgeAdapter;
    await seeded.upsert([{
      id: "docs#transfers.md",
      kind: "docs",
      visibility: "public",
      title: "Wire transfers",
      text: "# Wire transfers\nTransfers settle in one business day.",
      source: "docs/transfers.md",
    }]);

    const outcome = await search(vendo, "transfers settle business day");
    expect(outcome).toMatchObject({
      status: "ok",
      output: { outcome: "answered", hits: [{ docId: "docs#transfers.md" }] },
    });
  });
});
