import {
  VENDO_KNOWLEDGE_RESULT_KIND,
  VENDO_TOOL_TITLES,
  VendoError,
  type Json,
  type KnowledgeAdapter,
  type KnowledgeHit,
  type RunContext,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";

import { KNOWLEDGE_VERIFY_TIMEOUT_MS, type KnowledgeVerdict, type KnowledgeVerifier } from "./verifier.js";

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
  /** WHY this outcome, in the model's context so the agent can say what
      happened instead of shrugging. Two producers:
      - `unavailable`: the engine failure STATEMENT (the operator's remediation
        — "run `vendo login`…" — stays log-side, see describeEngineFailure);
      - `insufficient-evidence` from the VERIFIER: the gap it named, so the
        agent can say what the docs do not cover rather than a bare "I don't
        know". */
  message?: string;
  /** K15, additive envelope pin (`vendo/knowledge-result@1` stays compatible —
      §15 forward-compat: consumers that do not know this field ignore it).
      Set when the verifier was in play for these hits and produced NO verdict:
      the pre-verifier outcome stands, marked, so the UI can carry the amber
      "not verified against the documentation" treatment. A verifier that
      passed, and a host with no verifier at all, both leave it unset — the
      flag means "we could not check", never "we did not bother". */
  unverified?: true;
}

const descriptor: ToolDescriptor = {
  name: VENDO_KNOWLEDGE_SEARCH_TOOL,
  // §3 — what a person reads. Without it `ToolListing.title` falls back to the
  // identifier and the model speaks the slug (wave-1 proof E1-5).
  title: VENDO_TOOL_TITLES[VENDO_KNOWLEDGE_SEARCH_TOOL],
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
  /** The evidence check. Present = it runs on EVERY search that would return
      hits; absent = today's behavior, unchanged.

      Deliberately NOT score-gated (spec §The verifier pass, "not
      threshold-gated"). K14 gated it on a calibrated band and the live run
      showed the cost of that: four unanswerable questions per pass scored
      outside the band, were never checked, and were answered by the
      threshold. Gating the check on the number it exists to replace
      reintroduces the thing being fixed. */
  verifier?: KnowledgeVerifier;
  /** K15 — the whole turn's verification budget, shared by every verification
      one tool call makes. Default KNOWLEDGE_VERIFY_TURN_BUDGET_MS. */
  verifyTurnBudgetMs?: number;
}

/** K15 — what the verifier may add to ONE tool call, all verifications
    together. A chat search that escalates to deep verifies twice, so the
    per-call cap alone allowed ~10s on one turn; the turn budget is the wall
    the user actually feels. Sized at the per-call cap (measured p95 3.6s over
    183 verifications, docs/eval/KNOWLEDGE.md), so the common single
    verification is unaffected and the second one runs only in whatever time
    the first left. */
export const KNOWLEDGE_VERIFY_TURN_BUDGET_MS = KNOWLEDGE_VERIFY_TIMEOUT_MS;

/** Below this there is no point starting a model call: it would abort before
    a provider could answer, spending a request to produce no verdict. */
const MIN_VERIFY_BUDGET_MS = 250;

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

/** Identity of a hit set, so a deep retry that returned the same passages as
    the chat search reuses its verdict instead of paying a second model call
    to re-read the same text. */
const hitSetKey = (hits: KnowledgeHit[]): string =>
  hits.map((hit) => `${hit.ref.docId}\0${hit.ref.chunkId ?? ""}`).join("\x01");

/** What one verification attempt produced (see adjudicate). */
interface Adjudication {
  verdict?: KnowledgeVerdict;
  /** Asked, no verdict — fall open, and say so. */
  unverified?: true;
}

/** Verification state for ONE tool call: the shared time budget, and the memo
    that stops a deep retry paying to re-read passages the chat search already
    had verified. */
interface Turn {
  readonly budgetMs: number;
  spentMs: number;
  memoKey?: string;
  memo?: Adjudication;
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
  const breaker = new CallRateBreaker(options.maxCallsPerMinute ?? maxCallsPerMinuteFromEnv() ?? MAX_CALLS_PER_MINUTE);
  // K14 — the verifier composes only as a PAIR: a calibrated band saying where
  // the score is useless, and something to ask instead. Either alone leaves
  // the shipped path untouched.
  const verifier = options.verifier;
  const turnBudgetMs = options.verifyTurnBudgetMs ?? KNOWLEDGE_VERIFY_TURN_BUDGET_MS;

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

  // The evidence check for one search. Runs whenever there is a verifier and
  // there are hits — no score decides whether we bother.
  //
  // Three shapes come back:
  //   { verdict }          the verifier read the passages and decided;
  //   { unverified: true } it was asked and gave nothing back (timeout, no
  //                        model, unusable output, or no turn budget left);
  //   {}                   it was never in play — no verifier, or no hits.
  // The last two both fall open to the shipped threshold decision, so a broken
  // or slow verifier costs latency at worst, never an answer the host would
  // otherwise have got. Only the middle one is MARKED: the answer says "I
  // could not check this", which is the one thing a silent fail-open cannot.
  const adjudicate = async (
    question: string,
    hits: KnowledgeHit[],
    turn: Turn,
  ): Promise<Adjudication> => {
    if (verifier === undefined || hits.length === 0) return {};
    const key = hitSetKey(hits);
    if (turn.memoKey === key) return turn.memo ?? {};
    // The turn budget, not just the per-call cap: the deep retry gets what the
    // chat verification left, and nothing at all if it left nothing.
    const remaining = turn.budgetMs - turn.spentMs;
    if (remaining < MIN_VERIFY_BUDGET_MS) return { unverified: true };
    const startedAt = Date.now();
    const verdict = await verifier.verify(
      {
        question,
        passages: hits.slice(0, MAX_HITS).map((hit) => ({
          docId: hit.ref.docId,
          ...(hit.ref.title === undefined ? {} : { title: hit.ref.title }),
          snippet: hit.snippet,
        })),
      },
      { timeoutMs: remaining },
    );
    turn.spentMs += Date.now() - startedAt;
    const adjudication: Adjudication = verdict === undefined ? { unverified: true } : { verdict };
    turn.memoKey = key;
    turn.memo = adjudication;
    return adjudication;
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
          // K15 round 2: a lookup is still a hits-returning search — "every
          // search that returns hits" has no schema carve-out. A glossary hit
          // for the right term but the wrong fact is exactly the near-miss the
          // check exists for. Scores play no part here (they never did on this
          // path); the verdict, when there is one, is the arbiter.
          const lookupTurn: Turn = { budgetMs: turnBudgetMs, spentMs: 0 };
          const lookupCall = await adjudicate(input.query, result.hits, lookupTurn);
          const lookupHits = result.hits.slice(0, MAX_HITS).map(toCitation);
          const lookupMark = lookupCall.unverified === true ? { unverified: true as const } : {};
          if (lookupCall.verdict?.supported === false) {
            // Verifier-produced refusal: the engine just returned scored hits,
            // so it is alive — same reasoning as the query path's skipped
            // status() check.
            return envelope({
              outcome: "insufficient-evidence",
              hits: lookupHits,
              message: lookupCall.verdict.gap,
              ...lookupMark,
            });
          }
          return envelope({ outcome: "answered", hits: lookupHits, ...lookupMark });
        }

        // K14/K15 — one verification state per turn: the shared time budget,
        // and the memo that keeps the deep retry from paying a second
        // verification for the same passages (engines whose deep mode only
        // reranks return the same set).
        const turn: Turn = { budgetMs: turnBudgetMs, spentMs: 0 };
        // Sticky across both searches: a turn that could not verify once is
        // unverified whatever the second look decides on its own evidence.
        let unverified = false;
        const marked = (
          fields: Omit<KnowledgeResultEnvelope, "kind">,
        ): Omit<KnowledgeResultEnvelope, "kind"> =>
          unverified ? { ...fields, unverified: true } : fields;

        const chat = await adapter.search({ text: input.query, intent: "chat" }, knowledgeCtx);
        const chatCall = await adjudicate(input.query, chat.hits, turn);
        if (chatCall.unverified === true) unverified = true;
        if (chatCall.verdict?.supported === true
          || (chatCall.verdict === undefined && !isWeak(chat.hits, threshold))) {
          return envelope(marked({ outcome: "answered", hits: chat.hits.slice(0, MAX_HITS).map(toCitation) }));
        }
        // Weak chat evidence — or in-band evidence the verifier rejected —
        // → exactly one deep retry (engines without a deep mode treat it as
        // chat, so the retry is at worst a repeat).
        const deep = await adapter.search({ text: input.query, intent: "deep" }, knowledgeCtx);
        const deepCall = await adjudicate(input.query, deep.hits, turn);
        if (deepCall.unverified === true) unverified = true;
        if (deepCall.verdict?.supported === true
          || (deepCall.verdict === undefined && !isWeak(deep.hits, threshold))) {
          return envelope(marked({ outcome: "answered", hits: deep.hits.slice(0, MAX_HITS).map(toCitation) }));
        }
        // Structured refusal WITH the weak evidence: the model says it does
        // not know; the UI still gets whatever weak hits existed. The
        // status() check is the emptiness verification — skipped when the
        // VERIFIER produced the refusal, because an engine that just returned
        // scored passages has already proven it is alive.
        const verifierGap = deepCall.verdict?.supported === false ? deepCall.verdict.gap : undefined;
        if (verifierGap === undefined) await verifyEmptiness();
        return envelope(marked({
          outcome: "insufficient-evidence",
          hits: deep.hits.slice(0, MAX_HITS).map(toCitation),
          // The gap, not just the refusal: "the docs cover installing in React,
          // not Vue" is something the user can act on, and it is what the gap
          // log wants recorded.
          ...(verifierGap === undefined ? {} : { message: verifierGap }),
        }));
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
