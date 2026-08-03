import { createHash } from "node:crypto";
import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolveConsent } from "./consent.js";
import { baseProps, projectProps, type ProjectProps } from "./base-props.js";
import { CLOUD_PROP_KEYS, EVENT_ALLOWLIST, type EventName } from "./events.js";
import { scrubErrorDetail } from "./scrub.js";
import type { TelemetryConfig } from "./config.js";

const POSTHOG_ENDPOINT = "https://us.i.posthog.com/capture/";
const TIMEOUT_MS = 1500;

/**
 * The shipped default PostHog project (write-only, `phc_`) key. Safe to expose:
 * it can only capture events, never read data. Baked in so telemetry works for
 * users who install Vendo without any env setup. Override with
 * VENDO_POSTHOG_KEY to point at a different project.
 */
export const DEFAULT_POSTHOG_KEY = "phc_siVHW4wVh8yDeDzMgnjLGrYYqsHMceqfdqYF9fPEGXpS";

export interface TelemetryDeps {
  version: string;
  config: TelemetryConfig;
  env: Record<string, string | undefined>;
  /** Project directory for projectIdHash lookup; defaults to process.cwd(). */
  cwd?: string;
  runtime: boolean;
  posthogKey: string | undefined;
  fetchImpl?: typeof fetch;
}

export interface Telemetry {
  track(event: EventName, props: Record<string, unknown>): Promise<void>;
}

const MAX_STRING_LEN = 512;

/**
 * Bound an allowed value to a primitive: cap oversized strings and drop
 * anything non-primitive (objects, arrays, null) so an allowed key can't smuggle
 * an arbitrary or oversized payload through the allowlist.
 */
function boundValue(v: unknown): string | number | boolean | undefined {
  if (typeof v === "string") return v.length > MAX_STRING_LEN ? v.slice(0, MAX_STRING_LEN) : v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  return undefined;
}

/**
 * Filter caller props to the event's allowlist, widened by CLOUD_PROP_KEYS
 * when the cloud lane is active. With the lane inactive, cloud-only keys are
 * stripped even if callers pass them. errorDetail is re-scrubbed here as
 * defense-in-depth — the CLI already scrubs at the call site, but no raw
 * error text may leave this function regardless of what callers do.
 */
function filterToAllowlist(
  event: EventName,
  props: Record<string, unknown>,
  cloudActive: boolean,
): Record<string, unknown> {
  const allowed = EVENT_ALLOWLIST[event];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!allowed.has(k) && !(cloudActive && CLOUD_PROP_KEYS.has(k))) continue;
    // scrubErrorDetail returns "" for non-strings; `|| undefined` drops the
    // key instead of sending an empty string.
    const value = k === "errorDetail" ? scrubErrorDetail(v as string) || undefined : v;
    const bounded = boundValue(value);
    if (bounded !== undefined) out[k] = bounded;
  }
  return out;
}

/** Posts one capture body. Resolves on success, failure, or timeout — never
 *  rejects, and never outlives TIMEOUT_MS. */
type Post = (endpoint: string, body: string) => Promise<void>;

/** A capture endpoint behind a proxy can move (an http→https or bare-host
 *  redirect); fetch followed those for us, so the raw transport must too. The
 *  body is replayed as a POST on every hop: this is an API endpoint, where a
 *  redirect is always a relocation, never a "see other". */
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);
const MAX_REDIRECTS = 3;

/**
 * The default transport, and the reason it is not `fetch`. Node's global fetch
 * (undici) leaves a connecting socket alive after the request is aborted: on a
 * captive-portal network — one that accepts TCP and then never answers —
 * `vendo init` printed its summary and then sat there doing nothing until
 * undici's 10s connect timeout expired. A raw request hands us the socket, so
 * we unref it the moment it exists: a stranded telemetry POST can never be the
 * last handle keeping the CLI alive, under any network condition.
 *
 * The timeout is therefore the ONLY thing holding the caller — ref'd on
 * purpose, so an exiting process still reports its command's exit code instead
 * of racing an unref'd event loop to zero handles.
 */
function socketPost(endpoint: string, body: string): Promise<void> {
  return new Promise((resolve) => {
    let current: ClientRequest | undefined;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      current?.destroy();
      resolve();
    };
    const timer = setTimeout(finish, TIMEOUT_MS);

    const send = (url: URL, hopsLeft: number): void => {
      const request = (url.protocol === "http:" ? httpRequest : httpsRequest)(url, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      });
      current = request;
      // The socket exists only once the agent hands one over; unref it there so
      // a connect that never completes cannot keep the event loop alive.
      request.on("socket", (socket) => socket.unref());
      request.on("error", finish);
      request.on("response", (response) => {
        response.resume();
        const location = response.headers.location;
        if (hopsLeft > 0 && location !== undefined && REDIRECT_STATUSES.has(response.statusCode ?? 0)) {
          response.on("end", () => { if (!settled) send(new URL(location, url), hopsLeft - 1); });
          return;
        }
        response.on("end", finish);
        response.on("error", finish);
      });
      request.end(body);
    };
    send(new URL(endpoint), MAX_REDIRECTS);
  });
}

/** Transport for an injected `fetchImpl` (tests, and hosts that supply their
 *  own). A fetch response body is not a handle we can unref, so here the
 *  abort + timeout pair is the whole bound. */
function fetchPost(fetchImpl: typeof fetch): Post {
  return (endpoint, body) => new Promise<void>((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish();
    }, TIMEOUT_MS);

    void fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    }).then(finish, finish);
  });
}

/** Where capture events go. `VENDO_POSTHOG_HOST` redirects them at a
 *  self-hosted PostHog (and lets the CLI's exit tests aim at a black hole);
 *  unset means the shipped US cloud. */
function captureEndpoint(env: Record<string, string | undefined>): string {
  const host = env.VENDO_POSTHOG_HOST?.trim();
  if (!host) return POSTHOG_ENDPOINT;
  try {
    return new URL("/capture/", host).toString();
  } catch {
    return POSTHOG_ENDPOINT;
  }
}

/** Shape of a Vendo Cloud API key. Anything else leaves the lane anonymous. */
const CLOUD_KEY_RE = /^vnd_[0-9a-f]{40}$/;

export function createTelemetry(deps: TelemetryDeps): Telemetry {
  const post: Post = deps.fetchImpl === undefined ? socketPost : fetchPost(deps.fetchImpl);
  const endpoint = captureEndpoint(deps.env);
  // Cloud lane: a well-formed VENDO_API_KEY marks events as coming from a
  // Cloud-configured install. Producer-set like the base props — callers can
  // never pass `cloud` or `cloudKeyHash` themselves. cloudKeyHash is the
  // unsalted sha256 of the key: the console stores key hashes for joining,
  // and PostHog never receives the key itself. Deriving the lane here sends
  // nothing — every consent check still runs first inside track().
  const cloudKey = deps.env.VENDO_API_KEY;
  const cloudActive = typeof cloudKey === "string" && CLOUD_KEY_RE.test(cloudKey);
  const cloudMarkers = cloudActive
    ? { cloud: true, cloudKeyHash: createHash("sha256").update(cloudKey as string).digest("hex") }
    : {};
  // Internal lane: VENDO_INTERNAL=1 tags events instead of dropping them, so
  // internal harnesses (cert campaigns, eval sandboxes) that intentionally
  // exercise the real telemetry path stay verifiable end-to-end while
  // analytics filters them out on `internal = true`. Same truthy values as
  // consent.ts. Deliberately NOT a consent input — CI / DO_NOT_TRACK /
  // VENDO_TELEMETRY_DISABLED semantics are unchanged, and this marker is
  // producer-set like the cloud markers so callers can never spoof it.
  const internalMarker =
    deps.env.VENDO_INTERNAL === "1" || deps.env.VENDO_INTERNAL === "true"
      ? { internal: true }
      : {};
  // Filesystem-backed props are computed once per client, never per event.
  // Guarded so the never-throw contract holds at the API surface even if
  // cwd resolution or the filesystem probes fail in an unexpected way.
  let project: ProjectProps = {};
  try {
    project = projectProps(deps.env, deps.cwd);
  } catch {
    // Telemetry must never break the caller; send without project props.
  }
  return {
    async track(event, props) {
      try {
        if (!deps.posthogKey) return;
        const consent = resolveConsent({
          env: deps.env,
          optedOut: deps.config.optedOut,
          runtime: deps.runtime,
        });
        if (!consent.allowed) return;

        // Producer-set markers spread last so a caller-passed `cloud`,
        // `cloudKeyHash`, or `internal` (already filtered out above) can
        // never win.
        const properties = {
          ...baseProps(deps.version),
          ...project,
          ...filterToAllowlist(event, props, cloudActive),
          ...cloudMarkers,
          ...internalMarker,
        };
        const body = JSON.stringify({
          api_key: deps.posthogKey,
          event,
          distinct_id: deps.config.anonymousId,
          properties,
        });

        await post(endpoint, body);
      } catch {
        // Telemetry must never break a build or dev server. Intentional silent failure.
      }
    },
  };
}
