import { resolveConsent } from "./consent.js";
import { baseProps } from "./base-props.js";
import { EVENT_ALLOWLIST, type EventName } from "./events.js";
import type { TelemetryConfig } from "./config.js";

const POSTHOG_ENDPOINT = "https://us.i.posthog.com/capture/";
const TIMEOUT_MS = 1500;

/**
 * The shipped default PostHog project (write-only, `phc_`) key. Safe to expose:
 * it can only capture events, never read data. Baked in so telemetry works for
 * users who install Flowlet without any env setup. Override with
 * FLOWLET_POSTHOG_KEY to point at a different project.
 */
export const DEFAULT_POSTHOG_KEY = "phc_siVHW4wVh8yDeDzMgnjLGrYYqsHMceqfdqYF9fPEGXpS";

export interface TelemetryDeps {
  version: string;
  config: TelemetryConfig;
  env: Record<string, string | undefined>;
  runtime: boolean;
  posthogKey: string | undefined;
  fetchImpl?: typeof fetch;
}

export interface Telemetry {
  track(event: EventName, props: Record<string, unknown>): Promise<void>;
}

function filterToAllowlist(event: EventName, props: Record<string, unknown>): Record<string, unknown> {
  const allowed = EVENT_ALLOWLIST[event];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) if (allowed.has(k)) out[k] = v;
  return out;
}

export function createTelemetry(deps: TelemetryDeps): Telemetry {
  const doFetch = deps.fetchImpl ?? fetch;
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

        const properties = { ...baseProps(deps.version), ...filterToAllowlist(event, props) };
        const body = JSON.stringify({
          api_key: deps.posthogKey,
          event,
          distinct_id: deps.config.anonymousId,
          properties,
        });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          await doFetch(POSTHOG_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Telemetry must never break a build or dev server. Intentional silent failure.
      }
    },
  };
}
