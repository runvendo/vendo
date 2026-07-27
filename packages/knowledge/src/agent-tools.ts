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

import { inVerifyBand, type KnowledgeVerifyBand } from "./band.js";
import type { KnowledgeVerifier } from "./verifier.js";

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
  /** `unavailable` only — WHY the engine could not answer, in the model's
      context so the agent can say what happened instead of shrugging. Carries
      the failure STATEMENT only; the operator's remediation ("run `vendo
      login`…") is log-side (see describeEngineFailure). */
  message?: string;
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
  /** ENG-370 rate breaker: per-principal calls per rolling minute before the
      tool answers a loud "rate-limited" error. Explicit option wins over the
      VENDO_KNOWLEDGE_MAX_CALLS_PER_MINUTE env knob; default 60. */
  maxCallsPerMinute?: number;
  /** K14 — the score interval where `weakScoreThreshold` provably cannot
      decide (band.ts, per-engine like the bars). Inside it the verifier
      adjudicates; outside it nothing changes. No band, no verification. */
  verifyBand?: KnowledgeVerifyBand;
  /** K14 — the adjudicator for band scores. No verifier, no verification:
      the band alone changes nothing. */
  verifier?: KnowledgeVerifier;
}

/** ENG-370 default; the env knob is the operator escape hatch. */
const MAX_CALLS_PER_MINUTE = 60;

const maxCallsPerMinuteFromEnv = (): number | undefined => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const configured = Number(env?.["VENDO_KNOWLEDGE_MAX_CALLS_PER_MINUTE"]);
  return Number.isFinite(configured) && configured > 0 ? configured : undefined;
};

/** ENG-370 — a small in-memory rolling-minute breaker keyed by principal
    subject (guard.ts #recordCall is the house pattern, including the
    once-per-minute sweep that bounds the map for process lifetime). Scoped
    per registry instance; the tool composes once per createVendo, so the
    window is per-process like the guard's. */
class CallRateBreaker {
  #windows = new Map<string, number[]>();
  #lastSweepAt = 0;
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Records one call and reports whether it EXCEEDS the per-minute limit
      (call 61 of a 60-limit window trips; timestamps older than 60s fall out,
      so the window resets on its own). */
  record(subject: string): boolean {
    const at = Date.now();
    const cutoff = at - 60_000;
    this.#sweep(at);
    const active = (this.#windows.get(subject) ?? []).filter((timestamp) => timestamp > cutoff);
    active.push(at);
    this.#windows.set(subject, active);
    return active.length > this.#limit;
  }

  #sweep(at: number): void {
    if (at - this.#lastSweepAt < 60_000) return;
    this.#lastSweepAt = at;
    const cutoff = at - 60_000;
    for (const [subject, timestamps] of this.#windows) {
      if (!timestamps.some((timestamp) => timestamp > cutoff)) this.#windows.delete(subject);
    }
  }
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

/** The statistic the band is calibrated on: the best score a search came back
    with (the calibration's "top hit score"). Taken as the MAX rather than the
    first hit — adapters order by their own relevance, which is not always the
    raw score. Undefined when nothing scored: an engine that emits no scores
    can have no band decision, exactly as it has no threshold decision. */
function topScore(hits: KnowledgeHit[]): number | undefined {
  let top: number | undefined;
  for (const hit of hits) {
    if (typeof hit.score === "number" && (top === undefined || hit.score > top)) top = hit.score;
  }
  return top;
}

/** Identity of a hit set, so a deep retry that returned the same passages as
    the chat search reuses its verdict instead of paying a second model call
    to re-read the same text. */
const hitSetKey = (hits: KnowledgeHit[]): string =>
  hits.map((hit) => `${hit.ref.docId} ${hit.ref.chunkId ?? ""}`).join("");

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
  const breaker = new CallRateBreaker(options.maxCallsPerMinute ?? maxCallsPerMinuteFromEnv() ?? MAX_CALLS_PER_MINUTE);
  // K14 — the verifier composes only as a PAIR: a calibrated band saying where
  // the score is useless, and something to ask instead. Either alone leaves
  // the shipped path untouched.
  const band = options.verifier === undefined ? undefined : options.verifyBand;
  const verifier = options.verifier;

  // An engine failure has two audiences and they need different halves of the
  // same error (conductor amendment, 2026-07-27).
  //
  // The MODEL gets the statement — what failed — because an outcome with no
  // reason is the silence this whole seam exists to kill: the agent could not
  // distinguish "your key is rejected" from "the network blipped", and said
  // neither. The OPERATOR additionally gets the remediation, because they are
  // the only one who can act on it and nobody debugs a key from a chat
  // transcript. Adapter cloud errors already write themselves in exactly that
  // order, statement then remediation after an em dash ("Vendo Cloud rejected
  // the API key — run `vendo login` or check VENDO_API_KEY"), so the split is
  // a slice of the existing convention, not a rewrite of the message. An
  // error with no remediation clause is all statement, which is correct.
  const warned = new Set<string>();
  const describeEngineFailure = (error: unknown): string => {
    const raw = error instanceof Error ? error.message : String(error);
    const full = error instanceof VendoError ? `${error.code}: ${raw}` : raw;
    if (!warned.has(full)) {
      // Deduped by cause: a permanently broken engine costs one log line per
      // distinct failure, not one per turn.
      warned.add(full);
      console.warn(`[vendo] knowledge engine failed — ${VENDO_KNOWLEDGE_SEARCH_TOOL} answers "unavailable" until this is fixed: ${full}`);
    }
    return raw.split(" — ")[0]!;
  };

  // The status()-verified refusal (checker round 1): an empty/weak search
  // from a SICK engine must not pass as an honest refusal or not-found — the
  // emptiness is unverifiable. Consulted only on the zero/weak paths (a
  // strong answer never pays the status call); a throw propagates to the
  // caller's catch, which maps it to the loud "unavailable".
  const verifyEmptiness = async (): Promise<void> => {
    await adapter.status();
  };

  // K14 — the band decision for one search.
  //
  // Returns `true` (the passages support an answer), `false` (they do not), or
  // `undefined` meaning THE BAND DID NOT DECIDE — no band configured, no
  // scores to place, a score outside the band, or a verifier that gave no
  // verdict. Undefined is the fail-open path in every one of those cases: the
  // caller keeps the shipped threshold decision, so a broken or slow verifier
  // costs latency at worst, never an answer the host would otherwise have got.
  const adjudicate = async (
    question: string,
    hits: KnowledgeHit[],
    memo: { key?: string; verdict?: boolean },
  ): Promise<boolean | undefined> => {
    if (band === undefined || verifier === undefined || hits.length === 0) return undefined;
    const top = topScore(hits);
    if (top === undefined || !inVerifyBand(top, band)) return undefined;
    const key = hitSetKey(hits);
    if (memo.key === key) return memo.verdict;
    const verdict = await verifier.supported({
      question,
      passages: hits.slice(0, MAX_HITS).map((hit) => ({
        docId: hit.ref.docId,
        ...(hit.ref.title === undefined ? {} : { title: hit.ref.title }),
        snippet: hit.snippet,
      })),
    });
    memo.key = key;
    memo.verdict = verdict;
    return verdict;
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
      // ENG-370 breaker — LOUD, never a silent empty result. "rate-limited"
      // is the house wire code for this condition (Cloud device-login speaks
      // it); deliberately NOT a VendoErrorCode, so it never rides VendoError.
      if (breaker.record(ctx.principal.subject)) {
        return {
          status: "error",
          error: {
            code: "rate-limited",
            message: "Knowledge search is rate-limited for this user (too many calls in the last minute) — wait before retrying.",
          },
        };
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

        // K14 — one memo per turn, so the deep retry does not pay a second
        // verification for the same passages (engines whose deep mode only
        // reranks return the same set).
        const memo: { key?: string; verdict?: boolean } = {};

        const chat = await adapter.search({ text: input.query, intent: "chat" }, knowledgeCtx);
        const chatVerdict = await adjudicate(input.query, chat.hits, memo);
        if (chatVerdict === true || (chatVerdict === undefined && !isWeak(chat.hits, threshold))) {
          return envelope({ outcome: "answered", hits: chat.hits.slice(0, MAX_HITS).map(toCitation) });
        }
        // Weak chat evidence — or in-band evidence the verifier rejected —
        // → exactly one deep retry (engines without a deep mode treat it as
        // chat, so the retry is at worst a repeat).
        const deep = await adapter.search({ text: input.query, intent: "deep" }, knowledgeCtx);
        const deepVerdict = await adjudicate(input.query, deep.hits, memo);
        if (deepVerdict === true || (deepVerdict === undefined && !isWeak(deep.hits, threshold))) {
          return envelope({ outcome: "answered", hits: deep.hits.slice(0, MAX_HITS).map(toCitation) });
        }
        // Structured refusal WITH the weak evidence: the model says it does
        // not know; the UI still gets whatever weak hits existed. The
        // status() check is the emptiness verification — skipped when the
        // VERIFIER produced the refusal, because an engine that just returned
        // scored passages has already proven it is alive.
        if (deepVerdict !== false) await verifyEmptiness();
        return envelope({
          outcome: "insufficient-evidence",
          hits: deep.hits.slice(0, MAX_HITS).map(toCitation),
        });
      } catch (error) {
        // The loud engine-outage rule: a thrown adapter is NEVER a silent
        // empty result — the UI gets "unavailable", the model gets that plus
        // the reason, and the operator's log gets the reason plus the fix.
        return envelope({
          outcome: "unavailable",
          hits: [],
          message: describeEngineFailure(error),
        });
      }
    },
  };
}
