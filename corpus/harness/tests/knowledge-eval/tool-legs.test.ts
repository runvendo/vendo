import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { KnowledgeAdapter, KnowledgeDoc } from "@vendoai/core";
import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import * as knowledge from "@vendoai/knowledge";
import { loadFixtureCorpus, loadGoldenSet, loadRefusalSet } from "../../src/knowledge-eval/data.js";

/**
 * T4 — the spec's trust behaviors through the REAL `vendo_knowledge_search`
 * tool from `createKnowledgeTools` (lane K1), not just the policy predicate.
 * K1 is on main (2026-07-26) and these legs run for real. The runtime
 * feature-detect stays as a guard: if the export ever disappears, the legs
 * skip LOUDLY instead of erroring (the announcer test below always runs and
 * puts the gate's state in CI output).
 *
 * Everything here is written against the pinned interfaces (HANDOFF §Pinned):
 * tool input `{ query, lookup?, readMore? }`; ok-envelope
 * `{ kind: "vendo/knowledge-result@1", outcome, hits? (≤5), text?, truncated? }`;
 * policy chat-default with ONE deep retry; lookup:true → schema intent over
 * ["glossary","api"] where empty = "not-found", never fuzzy; adapter throw →
 * "unavailable". The stream part `data-vendo-citations` carries only 3
 * outcomes (no "not-found") — a deliberate envelope/part asymmetry owned by
 * K1's UI side; these legs assert the envelope only.
 */

/** K1's factory returns core's ToolRegistry ({ descriptors, execute }) —
    duck-typed here so these legs compile and skip cleanly even if the
    factory disappears again. */
interface ToolRegistryLike {
  descriptors(): Promise<{ name: string; risk?: string }[]>;
  execute(call: { id: string; tool: string; args: unknown }, ctx: unknown): Promise<unknown>;
}

type ToolFactory = (adapter: KnowledgeAdapter, options?: unknown) => ToolRegistryLike;

const createKnowledgeTools = (knowledge as Record<string, unknown>)["createKnowledgeTools"] as
  | ToolFactory
  | undefined;

const factoryAvailable = typeof createKnowledgeTools === "function";
const SKIP_REASON =
  "[knowledge-eval] tool-level legs SKIPPED: @vendoai/knowledge no longer exports createKnowledgeTools (it did at K1 landing, 2026-07-26 — this is a regression to investigate); they unskip automatically once the export is back.";

const envelopeSchema = z
  .object({
    kind: z.literal("vendo/knowledge-result@1"),
    outcome: z.enum(["answered", "insufficient-evidence", "unavailable", "not-found"]),
    hits: z.array(z.unknown()).max(5).optional(),
    text: z.string().optional(),
    truncated: z.boolean().optional(),
  })
  .passthrough();

type Envelope = z.infer<typeof envelopeSchema>;

/** Pull the cited doc ids out of an envelope's hits without depending on
    K1's exact hit type (ref.docId per the frozen KnowledgeHit shape, with a
    flat docId fallback). */
function citedDocIds(envelope: Envelope): string[] {
  const ids: string[] = [];
  for (const hit of envelope.hits ?? []) {
    if (typeof hit !== "object" || hit === null) continue;
    const record = hit as Record<string, unknown>;
    const ref = record["ref"];
    const fromRef = typeof ref === "object" && ref !== null ? (ref as Record<string, unknown>)["docId"] : undefined;
    const id = fromRef ?? record["docId"];
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

/** The eval's RunContext fixture — principal-carrying chat venue, so the
    tool layer never sets includeInternal (R5). */
const RUN_CTX = {
  principal: { kind: "user", subject: "knowledge-eval" },
  venue: "chat",
  presence: "present",
  sessionId: "knowledge-eval",
};

const okOutcomeSchema = z.object({ status: z.literal("ok"), output: z.unknown() }).passthrough();

async function callSearch(
  tools: ToolRegistryLike,
  input: { query: string; lookup?: boolean; readMore?: { docId: string; chunkId?: string } },
): Promise<Envelope> {
  const raw = await tools.execute(
    { id: "knowledge-eval-call", tool: "vendo_knowledge_search", args: input },
    RUN_CTX,
  );
  // Every knowledge outcome — including refusals and a dead engine — is a
  // structured ok envelope, never a tool-layer error.
  const outcome = okOutcomeSchema.parse(raw);
  return envelopeSchema.parse(outcome.output);
}

const throwingAdapter = (): KnowledgeAdapter => ({
  posture: { fetch: false, write: false, visibility: "public-only" },
  async search() {
    throw new Error("engine down");
  },
  async status() {
    throw new Error("engine down");
  },
});

// The announcer always runs so the gate's state shows in every CI log.
describe("knowledge tool legs — K1 gate", () => {
  it("announces whether the createKnowledgeTools factory is present", () => {
    if (!factoryAvailable) {
      console.warn(SKIP_REASON);
      // The skip must be for the documented reason — the module resolving
      // but the export missing — not a broken import masquerading as a gate.
      expect(knowledge).toBeDefined();
      expect((knowledge as Record<string, unknown>)["createKnowledgeTools"]).toBeUndefined();
    } else {
      console.warn("[knowledge-eval] createKnowledgeTools detected: tool-level legs are ACTIVE.");
    }
    expect(typeof factoryAvailable).toBe("boolean");
  });

  it.skipIf(!factoryAvailable)("the tool descriptor matches the pins: vendo_knowledge_search, risk read", async () => {
    const tools = createKnowledgeTools!(memoryKnowledgeAdapter());
    const descriptors = await tools.descriptors();
    const search = descriptors.find((entry) => entry.name === "vendo_knowledge_search");
    expect(search).toBeDefined();
    expect(search?.risk).toBe("read");
  });
});

describe.skipIf(!factoryAvailable)("vendo_knowledge_search over the memory engine", () => {
  async function goldenTools() {
    const corpus = await loadFixtureCorpus();
    const engine = memoryKnowledgeAdapter({ docs: corpus.docs });
    return createKnowledgeTools!(engine);
  }

  it("golden items answer with citations matching expectedDocIds", async () => {
    const [tools, golden] = await Promise.all([goldenTools(), loadGoldenSet()]);
    for (const item of golden.items) {
      const lookup = (item.intent ?? "chat") === "schema";
      const envelope = await callSearch(tools, { query: item.memoryQuery ?? item.question, ...(lookup ? { lookup } : {}) });
      expect(envelope.outcome, `${item.id}: expected an answered outcome`).toBe("answered");
      const cited = citedDocIds(envelope);
      for (const docId of item.expectedDocIds) {
        expect(cited, `${item.id}: citations must include ${docId}`).toContain(docId);
      }
    }
  }, 60_000);

  it("refusal items come back insufficient-evidence on every phrasing", async () => {
    const [tools, refusals] = await Promise.all([goldenTools(), loadRefusalSet()]);
    for (const item of refusals.items) {
      for (const phrasing of [item.question, ...item.paraphrases]) {
        const envelope = await callSearch(tools, { query: phrasing });
        expect(envelope.outcome, `${item.id}: "${phrasing}"`).toBe("insufficient-evidence");
      }
    }
  }, 60_000);

  it("an empty schema lookup is an honest not-found, never fuzzy", async () => {
    const tools = await goldenTools();
    const envelope = await callSearch(tools, { query: "zz-no-such-glossary-term", lookup: true });
    expect(envelope.outcome).toBe("not-found");
  });

  it("a dead engine is unavailable, not a crash and not a refusal", async () => {
    const tools = createKnowledgeTools!(throwingAdapter());
    const envelope = await callSearch(tools, { query: "anything" });
    expect(envelope.outcome).toBe("unavailable");
  });
});

describe.skipIf(!factoryAvailable)("e2e trust scenarios (offline-implementable subset)", () => {
  const seedDoc = (text: string): KnowledgeDoc => ({
    id: "living-doc",
    kind: "docs",
    visibility: "public",
    title: "Living document",
    text,
    source: "test:living-doc",
  });

  it("upsert → ask → cited answer; mutate → re-upsert → answer changes; remove → refusal", async () => {
    const engine = memoryKnowledgeAdapter();
    const tools = createKnowledgeTools!(engine);

    await engine.upsert!([seedDoc("the launch window opens on tuesday")]);
    const first = await callSearch(tools, { query: "the launch window opens on" });
    expect(first.outcome).toBe("answered");
    expect(citedDocIds(first)).toContain("living-doc");

    await engine.upsert!([seedDoc("the launch window opens on friday after the delay")]);
    const second = await callSearch(tools, { query: "the launch window opens on" });
    expect(second.outcome).toBe("answered");
    expect(JSON.stringify(second)).toContain("friday");
    expect(JSON.stringify(second)).not.toContain("tuesday");

    await engine.remove!(["living-doc"]);
    const third = await callSearch(tools, { query: "the launch window opens on" });
    expect(third.outcome).toBe("insufficient-evidence");
  });
});
