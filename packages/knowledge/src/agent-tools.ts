import {
  VENDO_KNOWLEDGE_RESULT_KIND,
  VendoError,
  type Json,
  type KnowledgeAdapter,
  type KnowledgeHit,
  type RunContext,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/** Knowledge K1 pin — `vendo_`-prefixed so the loadout policy keeps it always
    active (tool-search isAlwaysActive); a bare name could be gated out on
    hosts with a large tool surface. */
export const VENDO_KNOWLEDGE_SEARCH_TOOL = "vendo_knowledge_search";

/** The envelope tag core names once (stream-parts.ts) — re-exported so tool
    consumers keep pulling it from the package that produces the envelope. */
export { VENDO_KNOWLEDGE_RESULT_KIND } from "@vendoai/core";

/** The tool keeps ok.output comfortably under the agent's tool-output cap:
    the model gets trimmed snippets it can answer from; the FULL citation data
    rides the stream part the bridge writes before any capping. */
const MAX_HITS = 5;
const MAX_SNIPPET_CHARS = 280;

export interface KnowledgeCitation {
  docId: string;
  chunkId?: string;
  title?: string;
  source?: string;
  kind: KnowledgeHit["kind"];
  /** Checker round 1 (pin amended): rides from KnowledgeHit.visibility so
      the UI's origin line states it instead of guessing. */
  visibility: KnowledgeHit["visibility"];
  snippet: string;
}

export type KnowledgeResultOutcome = "answered" | "insufficient-evidence" | "unavailable" | "not-found";

/** The pinned `vendo/knowledge-result@1` envelope carried on ok.output. */
export interface KnowledgeResultEnvelope {
  kind: typeof VENDO_KNOWLEDGE_RESULT_KIND;
  outcome: KnowledgeResultOutcome;
  hits?: KnowledgeCitation[];
  /** Read-more only: the fetched document text, hard-trimmed by the caller. */
  text?: string;
  truncated?: boolean;
}

const descriptor: ToolDescriptor = {
  name: VENDO_KNOWLEDGE_SEARCH_TOOL,
  description: "Search the host's product knowledge base (documentation, glossary, API reference) and cite what you find. Use it whenever the user asks how the product works or what a term means. Set lookup:true for an exact glossary/API term lookup. Pass readMore:{docId} to read the full document behind an earlier hit when its snippet is not enough. An insufficient-evidence outcome means the knowledge base does not cover the question — say you don't know instead of guessing.",
  inputSchema: {
    $schema: DRAFT_2020_12,
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      lookup: { type: "boolean" },
      readMore: {
        type: "object",
        properties: {
          docId: { type: "string", minLength: 1 },
          chunkId: { type: "string", minLength: 1 },
        },
        required: ["docId"],
        additionalProperties: false,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  risk: "read",
};

export interface KnowledgeToolsOptions {
  /** Refusal calibration (per-engine, K2 evals): hits scoring below this are
      "weak". Default 0 — never triggers, so score-less/constant-score engines
      (the memory adapter) never falsely refuse. */
  weakScoreThreshold?: number;
}

interface KnowledgeSearchInput {
  query: string;
  lookup?: boolean;
  readMore?: { docId: string; chunkId?: string };
}

function parseInput(value: Json): KnowledgeSearchInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VendoError("validation", "tool input must be an object");
  }
  const record = value as Record<string, Json>;
  if (typeof record["query"] !== "string" || record["query"].trim() === "") {
    throw new VendoError("validation", "query must be a non-empty string");
  }
  if (record["lookup"] !== undefined && typeof record["lookup"] !== "boolean") {
    throw new VendoError("validation", "lookup must be a boolean");
  }
  let readMore: KnowledgeSearchInput["readMore"];
  if (record["readMore"] !== undefined) {
    const raw = record["readMore"];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new VendoError("validation", "readMore must be an object");
    }
    const ref = raw as Record<string, Json>;
    if (typeof ref["docId"] !== "string" || ref["docId"].trim() === "") {
      throw new VendoError("validation", "readMore.docId must be a non-empty string");
    }
    if (ref["chunkId"] !== undefined && (typeof ref["chunkId"] !== "string" || ref["chunkId"].trim() === "")) {
      throw new VendoError("validation", "readMore.chunkId must be a non-empty string");
    }
    readMore = {
      docId: ref["docId"],
      ...(ref["chunkId"] === undefined ? {} : { chunkId: ref["chunkId"] as string }),
    };
  }
  return {
    query: record["query"],
    ...(record["lookup"] === undefined ? {} : { lookup: record["lookup"] }),
    ...(readMore === undefined ? {} : { readMore }),
  };
}

const trimSnippet = (snippet: string): string =>
  snippet.length <= MAX_SNIPPET_CHARS ? snippet : `${snippet.slice(0, MAX_SNIPPET_CHARS)}…`;

export function toCitation(hit: KnowledgeHit): KnowledgeCitation {
  return {
    docId: hit.ref.docId,
    ...(hit.ref.chunkId === undefined ? {} : { chunkId: hit.ref.chunkId }),
    ...(hit.ref.title === undefined ? {} : { title: hit.ref.title }),
    ...(hit.ref.source === undefined ? {} : { source: hit.ref.source }),
    kind: hit.kind,
    visibility: hit.visibility,
    snippet: trimSnippet(hit.snippet),
  };
}

const errorOutcome = (error: unknown): ToolOutcome => ({
  status: "error",
  error: error instanceof VendoError
    ? { code: error.code, message: error.message }
    : { code: "internal", message: error instanceof Error ? error.message : "unknown knowledge error" },
});

/** Read-more sizing is the CALLER's job (core knowledge.ts: fetch returns up
    to the whole doc); this hard cap keeps one fetched document comfortably
    under the agent's tool-output cap. */
const READ_MORE_MAX_CHARS = 4000;

/** The refusal/escalation predicate: no evidence at all, or — for engines
    calibrated with a positive threshold — every scored hit below it. Hits
    without scores never count as weak (an uncalibrated engine must not
    refuse on scores it doesn't emit). */
function isWeak(hits: KnowledgeHit[], threshold: number): boolean {
  if (hits.length === 0) return true;
  if (threshold <= 0) return false;
  return hits.every((hit) => typeof hit.score === "number" && hit.score < threshold);
}

const envelope = (
  fields: Omit<KnowledgeResultEnvelope, "kind">,
): ToolOutcome => ({
  status: "ok",
  output: { kind: VENDO_KNOWLEDGE_RESULT_KIND, ...fields } as unknown as Json,
});

/** Knowledge K1 — the one knowledge agent tool behind core's adapter contract.
    The registry composes into createVendo exactly when a `knowledge` adapter
    is configured (selectKnowledge). Tool-layer policy (spec §Agent experience
    and trust): chat default → auto-escalate deep once on weak results →
    structured insufficient-evidence; lookup → schema over glossary/api with
    honest not-found; readMore → posture-gated fetch; adapter failure → loud
    unavailable, never a silent empty result. */
export function createKnowledgeTools(
  adapter: KnowledgeAdapter,
  options: KnowledgeToolsOptions = {},
): ToolRegistry {
  const threshold = options.weakScoreThreshold ?? 0;

  // The status()-verified refusal (checker round 1): an empty/weak search
  // from a SICK engine must not pass as an honest refusal or not-found — the
  // emptiness is unverifiable. Consulted only on the zero/weak paths (a
  // strong answer never pays the status call); a throw propagates to the
  // caller's catch, which maps it to the loud "unavailable".
  const verifyEmptiness = async (): Promise<void> => {
    await adapter.status();
  };

  const readMore = async (ref: { docId: string; chunkId?: string }, ctx: RunContext): Promise<ToolOutcome> => {
    if (adapter.posture.fetch !== true || adapter.fetch === undefined) {
      return {
        status: "error",
        error: {
          code: "not-implemented",
          message: "read-more is unavailable for this knowledge engine — answer from the search snippets instead.",
        },
      };
    }
    const result = await adapter.fetch(ref, { principal: ctx.principal });
    if (result === null) return envelope({ outcome: "not-found" });
    const truncated = result.text.length > READ_MORE_MAX_CHARS;
    return envelope({
      outcome: "answered",
      text: truncated ? result.text.slice(0, READ_MORE_MAX_CHARS) : result.text,
      ...(truncated || result.truncated === true ? { truncated: true } : {}),
    });
  };

  return {
    async descriptors() {
      return [structuredClone(descriptor)];
    },
    async execute(call, ctx: RunContext): Promise<ToolOutcome> {
      if (call.tool !== VENDO_KNOWLEDGE_SEARCH_TOOL) {
        return { status: "error", error: { code: "not-found", message: `Unknown tool: ${call.tool}` } };
      }
      let input: KnowledgeSearchInput;
      try {
        input = parseInput(call.args);
      } catch (error) {
        return errorOutcome(error);
      }

      // R5 (knowledge.ts KnowledgeContext): the agent path is
      // principal-carrying, so includeInternal is NEVER set here.
      const knowledgeCtx = { principal: ctx.principal };
      try {
        if (input.readMore !== undefined) return await readMore(input.readMore, ctx);

        if (input.lookup === true) {
          // Contract invariant (knowledge.ts R3): intent never implies kinds —
          // the schema lookup restricts to the structured-fact kinds
          // explicitly. An empty result is an honest not-found, never a fuzzy
          // fallback into prose docs.
          const result = await adapter.search(
            { text: input.query, intent: "schema", kinds: ["glossary", "api"] },
            knowledgeCtx,
          );
          if (result.hits.length === 0) {
            await verifyEmptiness();
            return envelope({ outcome: "not-found" });
          }
          return envelope({ outcome: "answered", hits: result.hits.slice(0, MAX_HITS).map(toCitation) });
        }

        const chat = await adapter.search({ text: input.query, intent: "chat" }, knowledgeCtx);
        if (!isWeak(chat.hits, threshold)) {
          return envelope({ outcome: "answered", hits: chat.hits.slice(0, MAX_HITS).map(toCitation) });
        }
        // Weak chat evidence → exactly one deep retry (engines without a deep
        // mode treat it as chat, so the retry is at worst a repeat).
        const deep = await adapter.search({ text: input.query, intent: "deep" }, knowledgeCtx);
        if (!isWeak(deep.hits, threshold)) {
          return envelope({ outcome: "answered", hits: deep.hits.slice(0, MAX_HITS).map(toCitation) });
        }
        // Structured refusal WITH the weak evidence: the model says it does
        // not know; the UI still gets whatever weak hits existed.
        await verifyEmptiness();
        return envelope({
          outcome: "insufficient-evidence",
          hits: deep.hits.slice(0, MAX_HITS).map(toCitation),
        });
      } catch {
        // The loud engine-outage rule: a thrown adapter is NEVER a silent
        // empty result — the model and the UI both see "unavailable".
        return envelope({ outcome: "unavailable", hits: [] });
      }
    },
  };
}
