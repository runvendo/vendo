import type { VendoUsageEvent } from "@vendoai/core";
import { consoleLogger, setLogger, setUsageSink } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudSandbox } from "../src/sandbox.js";
import { withSdkErrorReporting } from "../src/sdk-events.js";

/**
 * The provenance split on `sdk_error.data`. Reporting every value as its type
 * name defeated the point of the stream: an operator learned that "a ref was
 * malformed" and could not tell WHICH ref. Values Vendo itself MINTED now
 * travel verbatim; anything from the host, its end user, or the model travels
 * as its shape — and so does every key nobody has allowlisted, which is the
 * property that keeps a log site added tomorrow from leaking by default.
 *
 * A value that failed to decode is the caller's input, not Vendo's mint, so it
 * is classified against a closed set and never echoed — not even a prefix of
 * it. That distinction is what the marker cases below hold in place.
 */

const APP_ID = "app_2f6b1c0e-4d3a-4f52-9a71-0c8e5b2d7a13";

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
    expect(dataOf({ appId: APP_ID, path: "/home/someone/app/customers.ts" }))
      .toEqual({ appId: APP_ID, path: "string" });
  });

  it("defaults an unknown key to shapes-only, so a new log site leaks nothing", () => {
    expect(dataOf({ customerEmail: "ada@example.com", balanceCents: 4200, appId: APP_ID }))
      .toEqual({ customerEmail: "string", balanceCents: "number", appId: APP_ID });
  });

  it("falls back to the shape when an allowlisted value exceeds the length cap", () => {
    const atCap = `app_${"a".repeat(512 - "app_".length)}`;
    expect(dataOf({ appId: atCap })).toEqual({ appId: atCap });
    expect(dataOf({ appId: `${atCap}a` })).toEqual({ appId: "string" });
  });
});

describe("a snapshot ref the Cloud adapter cannot decode", () => {
  /** The failure path is the ONLY path that reports a ref, and a ref that
   *  failed to decode is by definition not one Vendo minted — it is whatever
   *  the caller passed to a public method. Echoing it back, even truncated,
   *  puts caller content on the wire. */
  it.each(["resume", "destroy"] as const)(
    "classifies the ref instead of echoing caller content, from %s()",
    async (method) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const seen = reported();
      setLogger(withSdkErrorReporting(consoleLogger));
      const adapter = cloudSandbox({
        apiKey: "vnd_test",
        fetch: (() => {
          throw new Error("an undecodable ref must never reach the console");
        }) as unknown as typeof fetch,
      });

      const marker = "SECRET=caller-controlled-telemetry-content";
      await expect(adapter[method](`oops ${marker}`)).rejects.toMatchObject({ code: "validation" });

      const errors = seen.filter((usage) => usage.name === "sdk_error");
      expect(errors).toHaveLength(1);
      expect(JSON.stringify(errors[0])).not.toContain(marker);
      // Still says WHICH WAY it is wrong, and correlates repeats of the same
      // bad ref — from Vendo's own vocabulary, never a slice of the input.
      expect(errors[0]).toMatchObject({
        data: {
          snapshotRefScheme: "(no known scheme)",
          snapshotRefLength: `oops ${marker}`.length,
          snapshotRefDigest: expect.stringMatching(/^[0-9a-f]{12}$/) as unknown,
        },
      });
    },
  );

  it("names the scheme a foreign ref announces, from Vendo's closed set", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen = reported();
    setLogger(withSdkErrorReporting(consoleLogger));
    const adapter = cloudSandbox({ apiKey: "vnd_test", fetch: (() => {
      throw new Error("unreachable");
    }) as unknown as typeof fetch });

    // The live incident: an e2b-minted ref a Cloud sandbox tried to resume.
    await expect(adapter.resume("e2b:v2:eyJzbmFwc2hvdElkIjoic25hcCJ9"))
      .rejects.toMatchObject({ code: "validation" });

    expect(seen.filter((usage) => usage.name === "sdk_error")[0])
      .toMatchObject({ data: { snapshotRefScheme: "e2b:v2:" } });
  });
});
