import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, vi } from "vitest";
import type { TelemetryOptions } from "./shared.js";

export interface CapturedEvent {
  event: string;
  properties: Record<string, unknown>;
}

/**
 * One sent body, whichever destination the event took. Product analytics go to
 * `/capture/` as an envelope; the operational events in LOG_EVENTS go to the
 * Logs product as OTLP records, where the name and the anonymous id are
 * attributes and every value is a string (that is how PostHog stores them
 * either way). Decoding both here keeps command tests asserting on what the
 * command reported, not on which endpoint it happened to use.
 */
function decode(body: string): CapturedEvent {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (parsed.resourceLogs === undefined) return parsed as unknown as CapturedEvent;
  const record = (parsed as never as {
    resourceLogs: { scopeLogs: { logRecords: {
      eventName: string;
      attributes: { key: string; value: { stringValue: string } }[];
    }[] }[] }[];
  }).resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
  const properties: Record<string, unknown> = {};
  for (const attribute of record.attributes) {
    if (attribute.key === "event" || attribute.key === "distinct_id") continue;
    properties[attribute.key] = attribute.value.stringValue;
  }
  return { event: record.eventName, properties };
}

/**
 * Injected telemetry seam for command tests: a REAL telemetry client pointed
 * at a mock PostHog fetch and a temp home, with a clean consent env (no
 * CI/DO_NOT_TRACK — the explicit `env` beats the suite-wide
 * VENDO_TELEMETRY_DISABLED in vitest.setup.ts). Callers add `home` to their
 * own cleanup list.
 */
export async function telemetryCapture(env: Record<string, string | undefined> = {}): Promise<{
  home: string;
  telemetry: TelemetryOptions;
  events: () => CapturedEvent[];
  /** The single event with this name; fails the test on 0 or 2+ matches. */
  event: (name: string) => CapturedEvent;
}> {
  const home = await mkdtemp(join(tmpdir(), "vendo-tele-home-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const fetchMock = vi.fn().mockResolvedValue({ ok: true });
  const events = (): CapturedEvent[] =>
    fetchMock.mock.calls.map((call) => decode((call[1] as { body: string }).body));
  return {
    home,
    telemetry: { home, env, posthogKey: "phc_test", fetchImpl: fetchMock as unknown as typeof fetch },
    events,
    event: (name) => {
      const matches = events().filter((entry) => entry.event === name);
      if (matches.length !== 1) {
        throw new Error(`expected exactly one ${name} event, saw ${matches.length} (all: ${events().map((entry) => entry.event).join(", ") || "none"})`);
      }
      return matches[0]!;
    },
  };
}
