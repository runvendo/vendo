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
import { emitUsage, type VendoLogger, type VendoUsageEvent } from "@vendoai/core";
import { envOptOut } from "@vendoai/telemetry";
import { createBatchedUploader } from "./batched-uploader.js";
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
 * The `data` keys that hold one of VENDO'S OWN identifiers.
 *
 * A CLOSED set of KEY NAMES, the same discipline as the CLI lane's
 * `CLOUD_PROP_KEYS`: a key nobody listed here — including every key a log site
 * added tomorrow — is shapes-only, so the default leaks nothing and opting a
 * key in is a deliberate edit to this list.
 *
 * The split is by PROVENANCE, not by usefulness. Reporting an incident is
 * pointless without the failing identifier ("a ref was malformed" does not say
 * WHICH ref), so a value Vendo itself minted travels verbatim — but anything
 * originating in the host's data, its end user's input, or the model's content
 * travels as its shape and nothing else.
 *
 * MINTED BY VENDO, not merely NAMED by Vendo. A key earns a place here only if
 * every value that can reach it was produced by this SDK. The question to ask
 * of a candidate is which code path logs it: a key logged on a FAILURE path
 * often holds the input that failed, and an input is the caller's, not ours.
 * Classify such a value against a closed set and report the classification;
 * never echo it, and never a prefix of it either.
 */
const VENDO_IDENTIFIER_KEYS: ReadonlySet<string> = new Set([
  // A CLASSIFICATION of a snapshot ref, never the ref (sandbox.ts): a matched
  // constant from Vendo's closed set of schemes, and a length. A raw
  // `snapshotRef` is deliberately NOT here — the only path that reports one is
  // the path where it FAILED to decode, and a ref that failed to decode is by
  // definition not Vendo-minted but whatever a caller handed a public method.
  // Nor is a DIGEST of one: an unkeyed hash of caller content confirms guesses
  // offline, which is a quieter version of the same leak.
  "snapshotRefScheme",
  "snapshotRefLength",
  // Vendo's `app_*` id namespace (core's `appIdSchema`) — the only thing that
  // says WHICH app failed.
  "appId",
  // `trn_<32 hex>`: core's `turnIdSchema` pins the WHOLE shape and
  // `mintTurnId` is the one mint, so it can hold nothing but random hex.
  "turnId",
  // A `VendoErrorCode` — a closed eight-member union in core, already
  // travelling verbatim on the `tool_call` event.
  "errorCode",
]);

/** No identifier Vendo mints comes near this. The cap is a VOLUME gate — an
 *  allowlisted key that unexpectedly holds something unbounded reports its
 *  shape instead, so no key on the list can become a content channel. */
const MAX_IDENTIFIER_CHARS = 512;

/** A log event's `data` carries a call site's ACTUAL arguments. Vendo's own
 *  identifiers ({@link VENDO_IDENTIFIER_KEYS}) travel as themselves — strings
 *  within the cap, and finite numbers, which are bounded by their own type.
 *  Every other key travels as its own name and the SHAPE of its value. */
function dataByProvenance(data: Record<string, unknown> | undefined): Record<string, unknown> {
  const reported: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    const verbatim = VENDO_IDENTIFIER_KEYS.has(key)
      && (typeof value === "number"
        ? Number.isFinite(value)
        : typeof value === "string" && value.length <= MAX_IDENTIFIER_CHARS);
    reported[key] = verbatim ? value : shapeOf(value);
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
