import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { TelemetryOptions } from "./shared.js";

export interface CapturedEvent {
  event: string;
  properties: Record<string, unknown>;
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
  const fetchMock = vi.fn().mockResolvedValue({ ok: true });
  const events = (): CapturedEvent[] =>
    fetchMock.mock.calls.map((call) => JSON.parse((call[1] as { body: string }).body) as CapturedEvent);
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
