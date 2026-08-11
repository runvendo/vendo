/**
 * `deployment_boot`'s `adapters` list, read where the console reads it: off the
 * telemetry POST this deployment's own events pipeline sends. No stub stands
 * between the composition and the assertion — the fetch seam is the far end of
 * the real write path, so producer and consumer cannot agree on a shape neither
 * of them ships.
 *
 * The list answers "which adapters is this deployment RUNNING", which is a
 * different question from "which slots did its host fill": every Cloud-defaulted
 * seam runs an adapter the host never passed. A suite that only ever set slots
 * explicitly would agree with a list built from `config` and prove nothing, so
 * the cases below leave the slots UNSET and let the adapter rule fill them.
 */
import { setLogger, setUsageSink, type VendoUsageEvent } from "@vendoai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "../src/server.js";
import type { CreateVendoConfig } from "../src/types.js";

/** Never resolved: the events pipeline is the only thing this suite lets talk. */
const CONSOLE_URL = "https://console.boot-test";

const bootEventsOf = (events: VendoUsageEvent[]): Extract<VendoUsageEvent, { name: "deployment_boot" }>[] =>
  events.filter((event) => event.name === "deployment_boot");

/** The one slot a composition cannot default; never resolved in this suite. */
const identity: Pick<CreateVendoConfig, "principal"> = {
  principal: async () => ({ kind: "user", subject: "user_boot_test" }),
};

/** Compose ONCE and hand back every usage event the stream actually uploaded. */
async function uploadedEvents(config: CreateVendoConfig = {}): Promise<VendoUsageEvent[]> {
  const uploaded: VendoUsageEvent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { events?: VendoUsageEvent[] };
    uploaded.push(...(body.events ?? []));
    return Response.json({ accepted: body.events?.length ?? 0 }, { status: 202 });
  }));
  createVendo({ ...identity, ...config });
  // The uploader batches on a 250ms timer. The budget is far under this
  // package's 30s test timeout, so the timeout stays the only hang-detector.
  await vi.waitFor(() => expect(uploaded.length).toBeGreaterThan(0), { timeout: 5_000, interval: 25 });
  return uploaded;
}

beforeEach(() => {
  // The Cloud slot is what fills every unset seam AND what installs the events
  // pipeline — one key, both halves, exactly as a deployed host has it.
  vi.stubEnv("VENDO_API_KEY", "vnd_boot_test");
  vi.stubEnv("VENDO_CLOUD_URL", CONSOLE_URL);
  // The stream's kill switches: vitest.setup.ts disables telemetry for the
  // whole package and a CI runner sets CI, and reading what the stream sends is
  // this suite's entire job.
  vi.stubEnv("VENDO_TELEMETRY_DISABLED", "");
  vi.stubEnv("DO_NOT_TRACK", "");
  vi.stubEnv("CI", "");
});

afterEach(() => {
  // A leaked sink or logger is another suite's failure, not this one's.
  setUsageSink(undefined);
  setLogger(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("deployment_boot's adapter list", () => {
  it("names a seam the host left UNSET that the adapter rule filled anyway", async () => {
    const [boot] = bootEventsOf(await uploadedEvents());
    // The live miss: demo-bank passes no `sandbox`, runs the Cloud sandbox, and
    // reported no sandbox at all — an invisible undercount of every deployment
    // that takes a default.
    expect(boot?.adapters).toContain("sandbox");
  });

  it("names every adapter a wholly unconfigured Cloud deployment runs", async () => {
    const [boot] = bootEventsOf(await uploadedEvents());
    expect(boot?.adapters).toEqual([
      "store",
      "files",
      "sandbox",
      "secrets",
      "harness",
      "connections",
      "knowledge",
      "connectors",
    ]);
  });

  it("leaves out a seam nothing runs — an explicit empty connector list", async () => {
    // "No connectors, ever" is a choice the seam honors, so no connector
    // composes and the name must not appear. Presence means running, both ways.
    const [boot] = bootEventsOf(await uploadedEvents({ connectors: [] }));
    expect(boot?.adapters).not.toContain("connectors");
    expect(boot?.adapters).toContain("sandbox");
  });
});

describe("deployment_boot's arity", () => {
  it("raises exactly one event per composition", async () => {
    // One composition is one deployment coming up. Two events from one process
    // therefore mean two compositions, and that is a fact about the host worth
    // seeing — never something this event may hide by deduplicating itself.
    expect(bootEventsOf(await uploadedEvents())).toHaveLength(1);
  });
});
