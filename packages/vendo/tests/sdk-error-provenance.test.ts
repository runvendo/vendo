import type { VendoUsageEvent } from "@vendoai/core";
import { consoleLogger, setLogger, setUsageSink } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudSandbox } from "../src/sandbox.js";
import { withSdkErrorReporting } from "../src/sdk-events.js";

/**
 * The provenance split on `sdk_error.data`. Reporting every value as its type
 * name defeated the point of the stream: an operator learned that "a ref was
 * malformed" and could not tell WHICH ref. Vendo's own identifiers now travel
 * verbatim; anything from the host, its end user, or the model travels as its
 * shape — and so does every key nobody has allowlisted, which is the property
 * that keeps a log site added tomorrow from leaking by default.
 */

/** A composite Cloud snapshot ref, the incident's identifier (sandbox.ts). */
const REF = "vendo:v2:eyJ2ZXJzaW9uIjoyLCJtYWNoaW5lSWQiOiJtXzEifQ";

const reported = (): VendoUsageEvent[] => {
  const seen: VendoUsageEvent[] = [];
  setUsageSink((usage) => seen.push(usage));
  return seen;
};

const dataOf = (data: Record<string, unknown>): unknown => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const seen = reported();
  withSdkErrorReporting(consoleLogger)({
    code: "vendo.boom", level: "error", message: "[vendo] e", data,
  });
  return (seen[0] as { data?: unknown } | undefined)?.data;
};

afterEach(() => {
  // A leaked sink or logger is another suite's failure, not this one's.
  setUsageSink(undefined);
  setLogger(undefined);
  vi.restoreAllMocks();
});

describe("sdk_error.data splits by provenance", () => {
  it("passes a Vendo identifier verbatim and shapes the host-derived key beside it", () => {
    expect(dataOf({ snapshotRef: REF, path: "/home/someone/app/customers.ts" }))
      .toEqual({ snapshotRef: REF, path: "string" });
  });

  it("defaults an unknown key to shapes-only, so a new log site leaks nothing", () => {
    expect(dataOf({ customerEmail: "ada@example.com", balanceCents: 4200, snapshotRef: REF }))
      .toEqual({ customerEmail: "string", balanceCents: "number", snapshotRef: REF });
  });

  it("falls back to the shape when an allowlisted value exceeds the length cap", () => {
    const atCap = `vendo:v2:${"a".repeat(512 - "vendo:v2:".length)}`;
    expect(dataOf({ snapshotRef: atCap })).toEqual({ snapshotRef: atCap });
    expect(dataOf({ snapshotRef: `${atCap}a` })).toEqual({ snapshotRef: "string" });
  });
});

describe("a snapshot ref the Cloud adapter cannot decode", () => {
  it("reports WHICH ref failed on the sdk_error stream", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen = reported();
    setLogger(withSdkErrorReporting(consoleLogger));
    const fetchImpl = vi.fn(async () => {
      throw new Error("an undecodable ref must never reach the console");
    });
    const adapter = cloudSandbox({
      apiKey: "vnd_test",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    // An e2b-minted ref handed to the Cloud adapter — the shape of the live
    // incident that started this.
    const ref = "e2b:v2:eyJzbmFwc2hvdElkIjoic25hcF9lMmIifQ";
    await expect(adapter.resume(ref)).rejects.toMatchObject({ code: "validation" });

    expect(fetchImpl).not.toHaveBeenCalled();
    const errors = seen.filter((usage) => usage.name === "sdk_error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ level: "error", data: { snapshotRef: ref } });
  });
});
