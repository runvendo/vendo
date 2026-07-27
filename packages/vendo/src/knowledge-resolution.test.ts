import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeAdapter, KnowledgeDoc, Principal, RunContext, ToolOutcome } from "@vendoai/core";
import { httpKnowledge, lexicalKnowledge } from "@vendoai/knowledge";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
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
 * broken product.
 *
 * This file pins every combination instead. Each engine answers with its own
 * marker document, so a row does not merely assert "a tool exists" — it names
 * which implementation actually served the query, and (for the rows where a
 * key is present but must lose) that the console saw no traffic at all.
 */

const CLOUD_BASE = "https://console.test";
const BYO_BASE = "https://byo.test/knowledge";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  // The seam reads the key itself; a developer's real key in the ambient env
  // must never decide what this suite observes.
  vi.stubEnv("VENDO_API_KEY", "");
  vi.stubEnv("VENDO_CLOUD_URL", "");
  // Same hazard for the verifier switch: a developer who turned it on in
  // their shell must not change what these rows observe. Unset = OFF.
  vi.stubEnv("VENDO_KNOWLEDGE_VERIFY", "");
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
    // Only mint a store when the row did not bring its own: spreading a
    // default here would build a whole PGlite database per compose and then
    // throw it away, which is what made the two-store rows slow enough to
    // trip the 30s default timeout under fleet load.
    ...(config.store === undefined ? { store: await tempStore() } : {}),
    ...config,
  });
}

const hasKnowledgeTool = async (vendo: Vendo): Promise<boolean> =>
  (await vendo.actions.descriptors()).some((descriptor) => descriptor.name === "vendo_knowledge_search");

const search = (vendo: Vendo, query = "how long do transfers take"): Promise<ToolOutcome> =>
  vendo.actions.execute({ id: "call_knowledge", tool: "vendo_knowledge_search", args: { query } }, ctx);

/** The docId the served answer cites — the identity of whichever engine the
    seam actually chose. */
function servingEngine(outcome: ToolOutcome): string | undefined {
  const output = (outcome as { output?: { hits?: Array<{ docId?: string }> } }).output;
  return output?.hits?.[0]?.docId;
}

const doc = (docId: string): KnowledgeDoc => ({
  id: docId,
  kind: "docs",
  visibility: "public",
  title: "Wire transfers",
  text: "# Wire transfers\nTransfers settle in one business day.",
  source: "docs/transfers.md",
});

/** An adapter the host passes by hand — the plainest form of "explicit". */
function probeKnowledge(docId: string): KnowledgeAdapter {
  return {
    posture: { fetch: false, write: false, visibility: "public-only" },
    async search() {
      return {
        hits: [{
          ref: { docId, title: "Wire transfers", source: "docs/transfers.md" },
          snippet: "Transfers settle in one business day.",
          kind: "docs",
          visibility: "public",
          score: 0.9,
        }],
      };
    },
    async status() {
      return { docs: 1, byKind: { docs: 1 } };
    },
  };
}

/** Two `vendo/knowledge-wire@1` mounts behind one `fetch`: the Cloud console
    and a BYO endpoint, each answering with its own marker doc and counting
    what it was asked. Everything else 404s, so a composition that reaches for
    an unexpected engine is visible rather than absorbed. */
function wireRouter(options: { cloudBearer?: string; score?: number } = {}): {
  fetch: typeof fetch;
  cloud: Array<{ url: string; authorization: string | null }>;
  byo: Array<{ url: string; authorization: string | null }>;
} {
  const cloud: Array<{ url: string; authorization: string | null }> = [];
  const byo: Array<{ url: string; authorization: string | null }> = [];
  const answer = (docId: string): Response => Response.json({
    hits: [{
      ref: { docId, title: "Wire transfers", source: "docs/transfers.md" },
      snippet: "Transfers settle in one business day.",
      kind: "docs",
      visibility: "public",
      // 0.9 sits above the Cloud engine's verification band, so a row that
      // does not care about K14 never pays a verification.
      score: options.score ?? 0.9,
    }],
  });

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const record = { url: request.url, authorization: request.headers.get("authorization") };
    if (request.url.startsWith(`${CLOUD_BASE}/api/v1/knowledge/`)) {
      cloud.push(record);
      if (options.cloudBearer !== undefined && record.authorization !== `Bearer ${options.cloudBearer}`) {
        return Response.json({ error: { code: "unauthorized", message: "Valid API key required." } }, { status: 401 });
      }
      return answer("doc-cloud");
    }
    if (request.url.startsWith(BYO_BASE)) {
      byo.push(record);
      return answer("doc-byo");
    }
    // Composition touches other console routes (tool overrides, config);
    // none of them are this router's business.
    return new Response("not found", { status: 404 });
  };
  return { fetch: handler as typeof fetch, cloud, byo };
}

const withKey = (key = "vnd_key"): void => {
  vi.stubEnv("VENDO_API_KEY", key);
  vi.stubEnv("VENDO_CLOUD_URL", CLOUD_BASE);
};

describe("knowledge resolution matrix (ENG-368) — which engine composes, and does the tool appear", () => {
  it("explicit adapter, no key: the host's adapter serves", async () => {
    const wire = wireRouter();
    vi.stubGlobal("fetch", wire.fetch);

    const vendo = await compose({ knowledge: probeKnowledge("doc-explicit") });

    expect(await hasKnowledgeTool(vendo)).toBe(true);
    expect(servingEngine(await search(vendo))).toBe("doc-explicit");
  });

  it("explicit adapter WITH a key: the adapter still wins and the console is never called", async () => {
    const wire = wireRouter();
    vi.stubGlobal("fetch", wire.fetch);
    withKey();

    const vendo = await compose({ knowledge: probeKnowledge("doc-explicit") });

    expect(servingEngine(await search(vendo))).toBe("doc-explicit");
    // The adapter rule's whole point: a key fills seams the host left unset,
    // it never shadows one the host filled.
    expect(wire.cloud).toEqual([]);
  });

  it("BYO wire endpoint WITH a key: the host's own endpoint serves, not Cloud", async () => {
    const wire = wireRouter();
    vi.stubGlobal("fetch", wire.fetch);
    withKey();

    const vendo = await compose({ knowledge: httpKnowledge({ url: BYO_BASE }) });

    expect(servingEngine(await search(vendo))).toBe("doc-byo");
    expect(wire.byo[0]?.url).toBe(`${BYO_BASE}/search`);
    expect(wire.cloud).toEqual([]);
  });

  it("key only: the Cloud engine composes from the key alone, with no hand-wiring", async () => {
    const wire = wireRouter();
    vi.stubGlobal("fetch", wire.fetch);
    withKey("vnd_key_only");

    const vendo = await compose();

    expect(await hasKnowledgeTool(vendo)).toBe(true);
    expect(servingEngine(await search(vendo))).toBe("doc-cloud");
    expect(wire.cloud[0]?.url).toBe(`${CLOUD_BASE}/api/v1/knowledge/search`);
    expect(wire.cloud[0]?.authorization).toBe("Bearer vnd_key_only");
  });

  it("zero-config lexicalKnowledge() WITH a key: the local engine serves over the composed store", async () => {
    const wire = wireRouter();
    vi.stubGlobal("fetch", wire.fetch);
    withKey();
    const store = await tempStore();
    await store.ensureSchema();
    await lexicalKnowledge({ store }).upsert!([doc("docs#composed-store.md")]);

    // No store plumbing anywhere in the host's config — exactly what
    // docs/knowledge.md promises.
    const vendo = await compose({ store, knowledge: lexicalKnowledge() });

    expect(servingEngine(await search(vendo, "transfers settle business day"))).toBe("docs#composed-store.md");
    expect(wire.cloud).toEqual([]);
  });

  it("lexicalKnowledge({ store }): the host's own knowledge database is never re-pointed at the composed one", async () => {
    const composed = await tempStore();
    const elsewhere = await tempStore();
    await composed.ensureSchema();
    await elsewhere.ensureSchema();
    await lexicalKnowledge({ store: composed }).upsert!([doc("docs#composed-store.md")]);
    await lexicalKnowledge({ store: elsewhere }).upsert!([doc("docs#other-database.md")]);

    const vendo = await compose({ store: composed, knowledge: lexicalKnowledge({ store: elsewhere }) });

    expect(servingEngine(await search(vendo, "transfers settle business day"))).toBe("docs#other-database.md");
    // Two real PGlite databases, both seeded through the ingestion pipeline —
    // the only row that needs more than the 30s default, and only when the
    // machine is loaded. A duration knob, not a softened assertion.
  }, 90_000);

  it("nothing configured: no adapter, no tool — the agent never advertises a knowledge base the host lacks", async () => {
    const vendo = await compose();

    expect(await hasKnowledgeTool(vendo)).toBe(false);
    expect(await search(vendo)).toMatchObject({ status: "error", error: { code: "not-found" } });
  });
});

describe("knowledge resolution — misconfiguration is audible", () => {
  it("a rejected key reaches the operator's log, not just an unavailable answer", async () => {
    const wire = wireRouter({ cloudBearer: "vnd_the_real_key" });
    vi.stubGlobal("fetch", wire.fetch);
    withKey("vnd_wrong_key");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const vendo = await compose();
    const outcome = await search(vendo);

    // The tool EXISTS — a wrong key is a configured host, not an absent one.
    expect(await hasKnowledgeTool(vendo)).toBe(true);
    expect(outcome).toMatchObject({ status: "ok", output: { outcome: "unavailable", hits: [] } });

    // HALF ONE — the model is TOLD WHY. An outcome with no reason is the
    // silence this lane exists to kill: the agent could not tell a rejected
    // key from a network blip, so it said neither.
    const output = (outcome as { output: { message?: string } }).output;
    expect(output.message).toMatch(/rejected the API key/);

    // HALF TWO — the remediation is the OPERATOR's, and only theirs. It must
    // reach the server log (they are the only one who can act on it) and must
    // not reach the model, which would put our infra setup instructions in
    // front of a bank's end user.
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toMatch(/rejected the API key/);
    expect(logged).toMatch(/vendo login/);
    expect(JSON.stringify(outcome)).not.toMatch(/vendo login/);
  });

  it("an unreachable console is unavailable-with-a-reason, never an empty corpus", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    withKey();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const outcome = await search(await compose());

    // "unavailable" and not "insufficient-evidence": an engine that cannot be
    // reached has not told us the corpus is empty, and the agent must not say
    // it looked and found nothing.
    // Both audiences again: the reason rides the envelope to the model, and
    // the same cause lands in the operator's log. An outage carries no
    // remediation clause, so the statement IS the whole message.
    expect(outcome).toMatchObject({
      status: "ok",
      output: { outcome: "unavailable", message: expect.stringMatching(/unreachable/) },
    });
    expect(warn.mock.calls.flat().join(" ")).toMatch(/unreachable/);
  });
});

/**
 * The evidence check at the composition seam.
 *
 * It is OFF by default (conductor ruling, checker round 1): the live run says
 * it does not clear the zero-false-answer bar it exists for, while adding a
 * model call per search and seconds of latency, so shipping it on would be a
 * product decision nobody made. `VENDO_KNOWLEDGE_VERIFY=on` opts in, and only
 * the Cloud engine composes it (scores and corpora differ per engine; nothing
 * else has been measured). It is NOT score-gated: rows below use scores from
 * across the range and every one of them is read.
 */
describe("knowledge evidence check — composition seam", () => {
  const IN_BAND = 0.75;

  /** The switch: unset means OFF, so rows that want the check ask for it. */
  const verifySwitch = (value: string): void => {
    vi.stubEnv("VENDO_KNOWLEDGE_VERIFY", value);
  };
  const optIn = (): void => verifySwitch("on");

  /** A verifier-slot model object answering with a fixed verdict. */
  function verdictModel(supported: boolean): LanguageModel & { calls: number } {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        return {
          // A real gap, not "test": the verdict schema rejects placeholders,
          // so a stub that emits one would silently yield NO verdict and this
          // suite would be asserting the fail-open path by accident.
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              supported,
              gap: supported
                ? "the passages state the wire transfer limit the question asks for"
                : "the passages cover transfers generally but never state this limit",
            }),
          }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
          warnings: [],
        };
      },
    }) as LanguageModel & { calls: number };
    Object.defineProperty(model, "calls", { get: () => calls });
    return model;
  }

  const outcomeOf = (result: ToolOutcome): string | undefined =>
    (result as { output?: { outcome?: string } }).output?.outcome;

  /** The K15 fail-open mark: set only when a verification was attempted and
      produced nothing. */
  const unverifiedFlag = (result: ToolOutcome): true | undefined =>
    (result as { output?: { unverified?: true } }).output?.unverified;

  it("cloud engine, in-band score, verifier says unsupported: the existing insufficient-evidence outcome", async () => {
    const wire = wireRouter({ score: IN_BAND });
    vi.stubGlobal("fetch", wire.fetch);
    withKey();
    optIn();
    const knowledgeVerifier = verdictModel(false);
    const vendo = await compose({ models: { knowledgeVerifier } });
    const result = await search(vendo);
    expect(outcomeOf(result)).toBe("insufficient-evidence");
    expect(knowledgeVerifier.calls).toBeGreaterThan(0);
    // The refusal is the SHIPPED one: still the knowledge envelope, still
    // carrying the weak evidence for the UI. No new outcome, no new surface.
    expect(servingEngine(result)).toBe("doc-cloud");
  });

  it("cloud engine, in-band score, verifier says supported: answered", async () => {
    const wire = wireRouter({ score: IN_BAND });
    vi.stubGlobal("fetch", wire.fetch);
    withKey();
    optIn();
    const vendo = await compose({ models: { knowledgeVerifier: verdictModel(true) } });
    const result = await search(vendo);
    expect(outcomeOf(result)).toBe("answered");
    // Verified, so nothing is flagged: the amber treatment means "could not
    // check", never "checked and passed".
    expect(unverifiedFlag(result)).toBeUndefined();
  });

  it("is OFF by default: an untouched Cloud host keeps today's behavior and spends nothing", async () => {
    const wire = wireRouter({ score: IN_BAND });
    vi.stubGlobal("fetch", wire.fetch);
    withKey();
    const knowledgeVerifier = verdictModel(false);
    const vendo = await compose({ models: { knowledgeVerifier } });
    const result = await search(vendo);
    expect(outcomeOf(result)).toBe("answered");
    expect(knowledgeVerifier.calls).toBe(0);
    // A host that never turned the check on is not "unverified" — it declined
    // the check, and the amber treatment would be a lie.
    expect(unverifiedFlag(result)).toBeUndefined();
  });

  it("VENDO_KNOWLEDGE_VERIFY=off is the same as unset", async () => {
    const wire = wireRouter({ score: IN_BAND });
    vi.stubGlobal("fetch", wire.fetch);
    withKey();
    verifySwitch("off");
    const knowledgeVerifier = verdictModel(false);
    const vendo = await compose({ models: { knowledgeVerifier } });
    expect(outcomeOf(await search(vendo))).toBe("answered");
    expect(knowledgeVerifier.calls).toBe(0);
  });

  it("a typo in VENDO_KNOWLEDGE_VERIFY fails loudly — never a silently-off trust feature", async () => {
    withKey();
    verifySwitch("yes-please");
    await expect(compose()).rejects.toThrow(/VENDO_KNOWLEDGE_VERIFY must be on or off/);
  });

  it("rides its OWN slot: models.knowledgeVerifier is used and the judge is left alone", async () => {
    const wire = wireRouter({ score: IN_BAND });
    vi.stubGlobal("fetch", wire.fetch);
    withKey();
    optIn();
    const judge = verdictModel(false);
    const knowledgeVerifier = verdictModel(false);
    const vendo = await compose({ models: { judge, knowledgeVerifier } });
    expect(outcomeOf(await search(vendo))).toBe("insufficient-evidence");
    expect(knowledgeVerifier.calls).toBeGreaterThan(0);
    expect(judge.calls).toBe(0);
  });

  it("a host's own engine is never held to another engine's calibration", async () => {
    // The check is Cloud-only: a host's own engine composes no verifier at
    // all, so its adapter answers exactly as it does today.
    optIn();
    const knowledgeVerifier = verdictModel(false);
    const vendo = await compose({
      knowledge: {
        ...probeKnowledge("doc-host"),
        async search() {
          return {
            hits: [{
              ref: { docId: "doc-host", title: "Wire transfers", source: "docs/transfers.md" },
              snippet: "Transfers settle in one business day.",
              kind: "docs" as const,
              visibility: "public" as const,
              score: IN_BAND,
            }],
          };
        },
      },
      models: { knowledgeVerifier },
    });
    expect(outcomeOf(await search(vendo))).toBe("answered");
    expect(knowledgeVerifier.calls).toBe(0);
  });

  it("no model credential at all: knowledge still answers — MARKED unverified, never blocked", async () => {
    const wire = wireRouter({ score: IN_BAND });
    vi.stubGlobal("fetch", wire.fetch);
    withKey();
    optIn();
    // The Cloud key resolves the verifier slot through the console gateway, so
    // strip it from the model ladder's view: no key, no provider module, no
    // verdict. The tool must answer the way it would have with no verifier at
    // all — and say that it could not check.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const vendo = await compose({
        models: { knowledgeVerifier: { doGenerate: undefined } as unknown as LanguageModel },
      });
      const result = await search(vendo);
      expect(outcomeOf(result)).toBe("answered");
      expect(unverifiedFlag(result)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("moves NO threshold: with the check ON but silent, every score decides as it did before", async () => {
    // The K14 regression: enabling verification also swapped the weak-score
    // threshold from 0 to the Cloud bar 0.7211, so a 0.61 score started
    // refusing without a single model call. Two decisions, two lives.
    const wire = wireRouter({ score: 0.61 });
    vi.stubGlobal("fetch", wire.fetch);
    withKey();
    optIn();
    // A model that never yields a usable verdict: the threshold is left to
    // decide, exactly as it does with no verifier composed.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const vendo = await compose({
        models: { knowledgeVerifier: { doGenerate: undefined } as unknown as LanguageModel },
      });
      expect(outcomeOf(await search(vendo))).toBe("answered");
    } finally {
      warn.mockRestore();
    }
  });

  it("is NOT score-gated: a score K14's band excluded is still read", async () => {
    // 0.61 sat below the old band and was answered unchecked; three of the
    // live run's persistent false answers were exactly that shape.
    const wire = wireRouter({ score: 0.61 });
    vi.stubGlobal("fetch", wire.fetch);
    withKey();
    optIn();
    const knowledgeVerifier = verdictModel(false);
    const vendo = await compose({ models: { knowledgeVerifier } });
    expect(outcomeOf(await search(vendo))).toBe("insufficient-evidence");
    expect(knowledgeVerifier.calls).toBeGreaterThan(0);
  });
});
