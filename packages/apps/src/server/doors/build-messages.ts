/**
 * What a build says when it fails, and the window it has to say anything.
 *
 * Lifted out of `createApps`' file unchanged. `runtime.ts` re-exports the three
 * refusal sentences and `buildFailureReason`, so nothing importing them moves.
 */
import {
  VendoError,
} from "@vendoai/core";
import {
  effectiveBuildWatchdogMs,
} from "../../contract/index.js";
import type { Finding } from "../checking/types.js";

/** The non-empty name a failed build record ships under (open() ignores it —
 *  the embed's title rides the app-ref — but validateAppDocument requires one).
 *  Collapsed and capped like the pack's fast-return title. */
export const fallbackAppName = (prompt: string): string => {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "Vendo app";
  return collapsed.length > 60 ? collapsed.slice(0, 60) : collapsed;
};

/** The two ways assembly comes back with nothing, said the same way wherever the
 *  seam is entered — `vendo_make`'s front door and the public create/edit API are
 *  the same engine now, so they must not grow two vocabularies for one failure. */
export const NO_ASSEMBLER = "nothing in this deployment builds screens.";
export const NOTHING_RENDERABLE = "the build produced nothing renderable.";
/** The one capability gap a person can act on, in their terms — no flag name and
 *  no adapter name. An escalation is a request for the box, and a deployment with
 *  no sandbox has no box to give it. Third person: these strings surface as
 *  SYSTEM notices, never in the assistant's voice. */
export const NO_MACHINE = "This needs a real build — code running on a server — and this deployment has no build machine.";

/** 0.4.5 E2E cert (defect D) — the terminal record the build watchdog writes
 *  when a create neither persisted an app nor a failure inside its window:
 *  the one class the in-band catch cannot cover (a build task that hangs or
 *  dies without ever settling). */
/** One finding as an operator log line. `where` is optional — a check judging the
 *  whole app may have no locus to name — so it is only printed when there is one,
 *  never as the string "undefined". */
export const findingLine = (finding: Finding): string =>
  `[vendo] gen ${finding.severity}${finding.where === undefined ? "" : ` ${finding.where}`}: ${finding.message}`;

/**
 * The commit gate moved. `blockedBy` / `notShipped` and their two lead
 * paragraphs lived here because the pipeline ran the checking layer INSIDE
 * create and edit and then refused at this commit path. Both doors are the
 * screen assembler now, and the assembler's saves land through `authored`
 * behind the paint seam's own floor (`AppsRuntime.floor`) — which runs for every
 * author rather than only for apps this package built. Deleted 2026-08-06 with
 * zero callers; what the person reads on a refusal is the engine's own reason,
 * verbatim, rather than a lead paragraph wrapped around it.
 */
export const BUILD_WATCHDOG_REASON =
  "the build never finished — the server-side build task stalled or died without reporting a "
  + "failure. Retry the request; if this repeats, check the host server log.";

/** Test seam and operator escape hatch, mirroring turn-liveness: the window a
 *  create has to persist SOMETHING (app or failure) before the watchdog writes
 *  the terminal failed record. Shared with the UI polling cutoff through
 *  @vendoai/core's build-deadlines module (speed-core lane), so the client
 *  always outlasts the watchdog and renders its record instead of the generic
 *  deadline beat. */
export const buildWatchdogMs = effectiveBuildWatchdogMs;

/**
 * Provider quota/billing language, and ONLY that. A quota claim is a statement
 * about the host's ACCOUNT and it is non-retryable, so a false positive tells
 * the person two lies at once — that they owe money, and that waiting helps.
 * The pattern used to include the bare words "insufficient" and "payment",
 * which are ordinary app and tool vocabulary: demo-bank's inventory carries
 * `host_listScheduledPayments`, so every finding that quoted the host tools
 * (checking/facts.ts) classified as a quota exhaustion (observed live
 * 2026-08-03, wave E2E). Word boundaries keep tool and field names out —
 * `host_getBilling` and `billing_id` have no boundary at the match edge —
 * and `insufficient_quota` (OpenAI's own code, where `_` is a word character)
 * is named explicitly for the same reason.
 *
 * Deliberately NOT here: "rate limit exceeded". A 429 rate limit clears in
 * seconds, so calling it a non-retryable quota exhaustion would just be a
 * different lie; it stays a retryable generic failure. OpenAI's quota refusal
 * also arrives as a 429 but carries `insufficient_quota`, which is matched.
 */
const QUOTA_SIGNAL = /\bquota\b|insufficient_quota|\bbilling\b|\b402\b/i;
const TIMEOUT_SIGNAL = /time?d?\s*out|timeout|abort/i;
/** The engine's stream-catch marker (generation/engine.ts askModel). It is the
 *  ONLY thing that distinguishes a provider's own error line from a validation
 *  finding once both are strings in the terminal throw's `issues`. */
const MODEL_ERROR_PREFIX = /^model generation failed: /;
/** The dev-model's own no-usable-credential lines (missing provider package,
 *  no key at all, or a key the provider REFUSED). These are written by Vendo,
 *  not a provider — the ONE failure class whose full message IS the honest
 *  reason, so it surfaces verbatim instead of collapsing to "generation failed"
 *  (0.4.x E2E: the surface said {code:"validation"} while the actionable
 *  `npm install @ai-sdk/...` line landed only in the operator terminal; the
 *  same swallowing was measured again 2026-08-03 for the 401 lines, where the
 *  generic reason was ALSO wrongly retryable — a revoked key fails identically
 *  on every retry). Anchored to the exact shapes in vendo/dev-creds
 *  (`rejectedKey`, `NO_CREDENTIAL_MESSAGE`) so a provider error that merely
 *  mentions a key can never leak through.
 *
 *  BYTE-FOR-BYTE COUPLED to those sentences, in another package this one may not
 *  import: reword a message without reworking this pattern and the actionable
 *  line silently stops reaching users (it lands only in the operator terminal —
 *  the 0.4.x defect, twice). The `Vendo has no model.` alternative below is
 *  `NO_CREDENTIAL_MESSAGE` in `@vendoai/vendo` (dev-creds/model.ts); the seam is
 *  tested against the real constant in that package's tests/dev-creds/model.test.ts. */
const MODEL_UNAVAILABLE_SIGNAL = /^(?:[A-Z][A-Z0-9_]* is set but @ai-sdk\/[\w-]+ is not installed in this app|Vendo has no model\.|your [A-Za-z]+ API key was rejected \(401\)|VENDO_API_KEY was rejected by the Vendo Cloud model gateway \(401\))/;

/**
 * Map a generation-turn throw to the short, honest, NON-LEAKY reason persisted
 * on the failed app record. Only the CANNED reason is ever emitted — the raw
 * provider message is used solely to classify, never surfaced.
 *
 * The engine's stream helper catches provider errors and folds their message
 * into the `issues` of the terminal `VendoError("validation", "model could not
 * produce a valid app")`, so the raw 402/AbortError rarely propagates intact:
 * classify from a raw error when it does (quota/timeout/cloud-required), and
 * otherwise from the PREFIXED provider lines among the validation issues —
 * never from the findings beside them — defaulting to a generic generation
 * failure the user can retry.
 */
export const buildFailureReason = (
  error: unknown,
): { reason: string; retryable: boolean } => {
  if (error instanceof Error && error.name === "AbortError") {
    return { reason: "timed out", retryable: true };
  }
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  if (statusCode === 402 || (error instanceof VendoError && error.code === "cloud-required")) {
    return { reason: "quota exhausted", retryable: false };
  }
  // What the PROVIDER (or the dev-model ladder) actually said, and nothing
  // else. A terminal validation throw's `issues` mix two unrelated kinds of
  // string: the engine's prefixed stream-catch lines, and the honesty gate's
  // findings — which quote the app's own content and the whole host tool
  // inventory. Classifying from the findings is how `host_listScheduledPayments`
  // became "quota exhausted". Such a throw's `message` is its own first issue
  // (runtime create, `conducted.issues[0]`), so it adds nothing but that same
  // leak and is read only when there are no issues to read.
  const detail = error instanceof VendoError && Array.isArray(error.detail)
    ? error.detail.filter((item): item is string => typeof item === "string")
    : undefined;
  const providerErrors = (detail === undefined
    ? [error instanceof Error ? error.message : String(error)]
    : detail.filter((issue) => MODEL_ERROR_PREFIX.test(issue))
  ).map((line) => line.replace(MODEL_ERROR_PREFIX, ""));
  // Vendo's own dev-model unavailable lines pass through verbatim (they are
  // the actionable fix), stripped of the engine's stream-catch prefix.
  const unavailable = providerErrors.find((line) => MODEL_UNAVAILABLE_SIGNAL.test(line));
  if (unavailable !== undefined) return { reason: unavailable, retryable: false };
  const text = providerErrors.join(" ");
  if (QUOTA_SIGNAL.test(text)) return { reason: "quota exhausted", retryable: false };
  if (TIMEOUT_SIGNAL.test(text)) return { reason: "timed out", retryable: true };
  return { reason: "generation failed", retryable: true };
};
