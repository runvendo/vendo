import { resolveConsent } from "./consent.js";
import { baseProps, projectProps, type ProjectProps } from "./base-props.js";
import { EVENT_ALLOWLIST, type EventName } from "./events.js";
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

function filterToAllowlist(event: EventName, props: Record<string, unknown>): Record<string, unknown> {
  const allowed = EVENT_ALLOWLIST[event];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!allowed.has(k)) continue;
    const bounded = boundValue(v);
    if (bounded !== undefined) out[k] = bounded;
  }
  return out;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
}

export function createTelemetry(deps: TelemetryDeps): Telemetry {
  const doFetch = deps.fetchImpl ?? fetch;
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

        const properties = { ...baseProps(deps.version), ...project, ...filterToAllowlist(event, props) };
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
