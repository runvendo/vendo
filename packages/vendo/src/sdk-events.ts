/** The SDK's own usage/error stream: core's closed `VendoUsageEvent` catalog,
 *  batched to the console on the SAME terms the capability-miss stream uploads.
 *
 * Consent is that contract, not a second one: a Cloud key fills the slot at the
 * composition seam (never read from the environment here), and `envOptOut` —
 * `VENDO_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, `CI` — is the kill switch. It runs
 * in production; NODE_ENV gates nothing. No key or an opt-out means
 * `createSdkEvents` hands back `undefined`, no sink is installed, and
 * `emitUsage` stays the no-op it is by default.
 *
 * WHO this deployment is never rides the body. The identity headers
 * (`deployment-identity.ts`) already travel on every keyed call and the console
 * resolves org/project/deployment from them server-side — naming any of the
 * three here would let a deployment claim to be another one.
 *
 * Keep this module free of node builtins; the portability gate bundles it.
 */
import { emitUsage, vendoErrorCodeSchema, type VendoLogger, type VendoUsageEvent } from "@vendoai/core";
import { envOptOut } from "@vendoai/telemetry";
import { createBatchedUploader } from "./batched-uploader.js";
import { KNOWN_REF_SCHEMES, UNKNOWN_REF_SCHEME } from "./sandbox-wire.js";
import { VERSION } from "./wire/shared.js";

/** The console door this stream POSTs to. ONE constant: the route is the
 *  console's to name, and renaming it is a one-line change here. Deliberately
 *  NOT `/api/v1/events` — that door is the console's end-user activity ingest,
 *  with a different vocabulary and a different size cap. */
const TELEMETRY_PATH = "/api/v1/telemetry";

export interface SdkEventsPipeline {
  record(event: VendoUsageEvent): void;
  /** Drain hook for tests and orderly host shutdown; a turn never awaits it. */
  flush(): Promise<void>;
}

export interface SdkEventsOptions {
  /** ADAPTER RULE, events slot: filled by the composition seam
   *  (`cloudKeyOptions()`), never from the environment here. */
  cloud?: { apiKey: string; baseUrl?: string };
  /** Opt-out inputs only (`envOptOut`); never a key or a base URL. */
  env?: Record<string, string | undefined>;
  /** Which JS runtime this deployment boots on — see {@link sdkRuntime}. */
  runtime: string;
  fetchImpl?: typeof fetch;
}

function runtimeEnv(): Record<string, string | undefined> {
  return typeof process === "undefined" ? {} : process.env;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The runtime's own NAME, from the globals each one advertises. Reported so a
 *  crash on the edge is not read as a crash on Node; never a version, a path or
 *  a machine. */
export function sdkRuntime(): string {
  const globals = globalThis as {
    navigator?: { userAgent?: string };
    EdgeRuntime?: unknown;
    process?: { versions?: Record<string, string | undefined> };
  };
  if (globals.navigator?.userAgent === "Cloudflare-Workers") return "workerd";
  if (globals.EdgeRuntime !== undefined) return "edge-light";
  const versions = globals.process?.versions;
  if (versions?.bun !== undefined) return "bun";
  if (versions?.deno !== undefined) return "deno";
  if (versions?.node !== undefined) return "node";
  return "unknown";
}

/**
 * The events pipeline for this deployment, or `undefined` when it has no
 * business existing — no Cloud slot, or an environment opt-out.
 */
export function createSdkEvents(options: SdkEventsOptions): SdkEventsPipeline | undefined {
  const cloud = options.cloud;
  if (cloud === undefined || envOptOut(options.env ?? runtimeEnv())) return undefined;
  const uploader = createBatchedUploader<VendoUsageEvent>({
    path: TELEMETRY_PATH,
    cloud,
    body: (events) => ({ version: VERSION, runtime: options.runtime, events }),
    // The route's answer shape is the console's to fix; any JSON object counts
    // as delivered (a non-2xx already throws inside cloudKeyFetch), so a shape
    // this SDK release has not learned yet never costs three retries a batch.
    accept: isObject,
    // The console's kill switch: it says stop, this process stops for good.
    stop: (response) => isObject(response) && response.disabled === true,
    fetchImpl: options.fetchImpl,
  });
  return {
    record: (event) => uploader.enqueue(event),
    flush: () => uploader.flush(),
  };
}

/**
 * Wrap a logger so what Vendo warns or fails about ALSO becomes an `sdk_error`.
 *
 * The console line is untouched — the wrapped logger calls the one it wraps
 * first and adds nothing to it, so a host's output stays byte-identical whether
 * or not the events stream exists. `debug` and `info` are the machine narrating
 * itself and never report.
 */
export function withSdkErrorReporting(logger: VendoLogger): VendoLogger {
  return (event) => {
    logger(event);
    if (event.level !== "warn" && event.level !== "error") return;
    emitUsage({
      name: "sdk_error",
      code: event.code,
      level: event.level,
      message: event.message,
      data: dataByProvenance(event.data),
      // The frames of the Vendo call site that logged this, which is the
      // question an operator actually has ("where in Vendo?").
      stack: vendoFrames(new Error().stack),
      runtime: sdkRuntime(),
    });
  };
}

/**
 * The `data` keys that may travel VERBATIM, each with the CLOSED SET its value
 * has to belong to before it does.
 *
 * A closed set of KEY NAMES was not enough, and this map is the correction: the
 * name said `errorCode` while nothing checked the value WAS an error code, so
 * any string a caller could reach that key with travelled unchanged, up to a
 * length cap that was never the point. A key name is a CLAIM about a value.
 * This checks the claim.
 *
 * CLASSIFICATION ONLY. The rule: an allowlisted key's value is validated
 * against a closed set or a scalar type, and anything that does not conform is
 * reduced to its type name — exactly as a key nobody allowlisted already is.
 * So no caller-influenced value leaves the customer's servers; the verbatim
 * value stays in their local logs and their hosted-DB lookup, and only a
 * classification of it travels. A key nobody listed here — including every key
 * a log site adds tomorrow — is shapes-only, so the default still leaks
 * nothing.
 *
 * That makes the boundary safe BY CONSTRUCTION rather than by argument: what
 * can travel is ENUMERABLE, and every one of those values is Vendo-authored. A
 * candidate key with no closed set to check against does not belong here,
 * whatever it is called.
 *
 * Each check reads its vocabulary from that vocabulary's OWNER — the schemes
 * from `sandbox-wire.ts`, the codes from core's `vendoErrorCodeSchema` — never
 * a local re-listing, so a check and the thing it checks cannot drift apart.
 *
 * REMOVED, and not to be re-added by reasoning that the namespaces are Vendo's
 * — both are caller-suppliable on a live path, and neither has any closed set
 * to be validated against:
 *   - `appId`: `apps/src/server/doors/build-surface.ts:286` is
 *     `input.appId ?? mint`, and `appIdSchema` pins only the `app_` prefix, so
 *     a caller's app id is `app_` followed by anything at all.
 *   - `turnId`: `screen-agent.ts:855` is `surface.turnId ?? mintTurnId()`.
 *     `turnIdSchema` does pin the whole `trn_<32 hex>` shape, but nothing
 *     parses that path through it — a `TurnId` is a bare `string`, and the
 *     type's stated contract is that it is opaque and nobody parses it.
 */
const VERBATIM_DATA_VALUES: ReadonlyMap<string, (value: unknown) => boolean> = new Map([
  // A CLASSIFICATION of a snapshot ref, never the ref (sandbox.ts): the matched
  // constant from Vendo's closed set of schemes, or the sentinel for no match.
  // A raw `snapshotRef` is deliberately NOT a key here — the only path that
  // reports one is the path where it FAILED to decode, and a ref that failed to
  // decode is by definition not Vendo-minted but whatever a caller handed a
  // public method. Nor is a DIGEST of one: an unkeyed hash of caller content
  // confirms guesses offline, which is a quieter version of the same leak.
  ["snapshotRefScheme", (value) => typeof value === "string"
    && (value === UNKNOWN_REF_SCHEME || KNOWN_REF_SCHEMES.some((scheme) => scheme === value))],
  // How long the ref was, which says nothing about what was in it.
  ["snapshotRefLength", (value) => typeof value === "number" && Number.isFinite(value)],
  // A `VendoErrorCode`, checked against core's schema rather than a re-listing
  // of its members. FORWARD-LOOKING on purpose: no log site puts one in `data`
  // today (it rides `agent_run` instead), so this entry is deliberate rather
  // than an oversight, and it is here so the first log site that does report
  // one is not silently reduced to "string".
  ["errorCode", (value) => vendoErrorCodeSchema.safeParse(value).success],
]);

/** A log event's `data` carries a call site's ACTUAL arguments. A key travels
 *  verbatim only when it is allowlisted AND its value passes that key's check
 *  ({@link VERBATIM_DATA_VALUES}); everything else — an unlisted key, and a
 *  listed key holding something it should never hold — travels as its own name
 *  and the SHAPE of its value.
 *
 *  There is deliberately no length cap any more. One used to stand in for this
 *  check, and it was the bug: it let 512 characters of anything through under a
 *  name that promised a classification. Now that every conforming value is one
 *  of a handful of Vendo-authored constants or a number, a cap could never
 *  fire, and keeping an unreachable one would only re-suggest that volume is
 *  the risk. It is not; provenance is. */
function dataByProvenance(data: Record<string, unknown> | undefined): Record<string, unknown> {
  const reported: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    reported[key] = VERBATIM_DATA_VALUES.get(key)?.(value) === true ? value : shapeOf(value);
  }
  return reported;
}

function shapeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Error) return value.name;
  return typeof value;
}

/**
 * The `@vendoai` frames of a stack, each trimmed to start at the package name.
 *
 * A host application's own frames are the host's business and never travel, and
 * the trim drops the absolute prefix every frame carries — which is a machine's
 * home directory. A source-tree frame (`packages/vendo/src/…`, a monorepo
 * checkout) names no package and is dropped with the rest.
 */
export function vendoFrames(stack: string | undefined): string[] {
  if (stack === undefined) return [];
  return stack.split("\n").flatMap((line) => {
    const at = line.indexOf("@vendoai/");
    return at === -1 ? [] : [line.slice(at).replace(/\)+$/, "")];
  });
}
