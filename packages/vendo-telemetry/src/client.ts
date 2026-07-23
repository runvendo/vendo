import { createHash } from "node:crypto";
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

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
}

/** Shape of a Vendo Cloud API key. Anything else leaves the lane anonymous. */
const CLOUD_KEY_RE = /^vnd_[0-9a-f]{40}$/;

export function createTelemetry(deps: TelemetryDeps): Telemetry {
  const doFetch = deps.fetchImpl ?? fetch;
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

        const controller = new AbortController();
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            controller.abort();
            finish();
          }, TIMEOUT_MS);
          unrefTimer(timer);

          void doFetch(POSTHOG_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: controller.signal,
          }).then(finish, finish);
        });
      } catch {
        // Telemetry must never break a build or dev server. Intentional silent failure.
      }
    },
  };
}
