import type { VendoUsageEvent } from "@vendoai/core";
import { consoleLogger, setLogger, setUsageSink } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudSandbox } from "../src/sandbox.js";
import { withSdkErrorReporting } from "../src/sdk-events.js";

/**
 * What `sdk_error.data` is allowed to say. CLASSIFICATION ONLY: no
 * caller-influenced value leaves the customer's servers.
 *
 * The rule is about VALUES, not key names. An allowlisted key's value is
 * validated against a closed set or a scalar type, and anything that does not
 * conform is reduced to its type name — exactly as a key nobody allowlisted
 * already is. Allowlisting a NAME was the earlier, weaker version of this and
 * it shipped a leak: `errorCode` promised a closed union while nothing checked
 * for one, so caller content travelled verbatim under it.
 *
 * Two failure modes, and the cases below hold both:
 *   - a key whose value a caller supplies (`appId`, `turnId` — both spelled in
 *     Vendo's own id namespace, which is exactly why the NAME is not the test)
 *   - an allowlisted key handed something outside its closed set
 *
 * A value that failed to decode is the caller's input for the same reason —
 * classified against a closed set, never echoed, not even a prefix of it. That
 * distinction is what the marker cases hold in place.
 */

/** Caller-suppliable on a live path, so neither may travel: `input.appId ??
 *  mint` in apps' build-surface door, `surface.turnId ?? mintTurnId()` in the
 *  screen agent. Both are spelled exactly as Vendo would mint them, which is
 *  the point — a well-formed value proves nothing about where it came from. */
const APP_ID = "app_2f6b1c0e-4d3a-4f52-9a71-0c8e5b2d7a13";
const TURN_ID = "trn_0123456789abcdef0123456789abcdef";

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

describe("sdk_error.data reports classifications and shapes everything else", () => {
  it("passes a classification verbatim and shapes the host-derived key beside it", () => {
    expect(dataOf({ snapshotRefScheme: "e2b:v2:", path: "/home/someone/app/customers.ts" }))
      .toEqual({ snapshotRefScheme: "e2b:v2:", path: "string" });
  });

  it("defaults an unknown key to shapes-only, so a new log site leaks nothing", () => {
    expect(dataOf({ customerEmail: "ada@example.com", balanceCents: 4200, snapshotRefScheme: "fake:" }))
      .toEqual({ customerEmail: "string", balanceCents: "number", snapshotRefScheme: "fake:" });
  });

  /** The apps create door mints an app id only when the caller passed none
   *  (`input.appId ?? mint`), and `appIdSchema` pins the `app_` prefix and
   *  NOTHING after it — so an `app_` value is `app_` plus arbitrary caller
   *  content, and a well-formed one is indistinguishable from a minted one. */
  it("reports a caller-suppliable appId as its type, never its value", () => {
    expect(dataOf({ appId: APP_ID })).toEqual({ appId: "string" });
  });

  /** `turnIdSchema` pins the whole `trn_<32 hex>` shape, but no door parses the
   *  screen agent's `surface.turnId` through it: a `TurnId` is a bare `string`
   *  whose stated contract is that nobody parses it. A schema that is never
   *  applied constrains nothing. */
  it("reports a caller-suppliable turnId as its type, never its value", () => {
    expect(dataOf({ turnId: TURN_ID })).toEqual({ turnId: "string" });
  });

  /** Being allowlisted buys the KEY nothing on its own — the value still has to
   *  be one of the six constants `sandbox-wire.ts` names, or the sentinel. A
   *  scheme-shaped string that is not on that list is caller content wearing a
   *  classification's name. */
  it("passes a snapshot scheme from the closed set, and shapes anything else under that key", () => {
    expect(dataOf({ snapshotRefScheme: "(no known scheme)" }))
      .toEqual({ snapshotRefScheme: "(no known scheme)" });
    expect(dataOf({ snapshotRefScheme: "s3cret-leak:" })).toEqual({ snapshotRefScheme: "string" });
  });

  /** The length key means a LENGTH. A string under it is a whole ref smuggled
   *  through a key whose name promised a scalar. */
  it("passes a numeric snapshotRefLength, and shapes a non-number under that key", () => {
    expect(dataOf({ snapshotRefLength: 42 })).toEqual({ snapshotRefLength: 42 });
    expect(dataOf({ snapshotRefLength: "vendo:v2:eyJzZWNyZXQiOiJsZWFrIn0" }))
      .toEqual({ snapshotRefLength: "string" });
  });

  /** Greptile's finding on #1222, pinned so it cannot come back. The key name
   *  claimed the closed `VendoErrorCode` union while NOTHING checked for one,
   *  and the old length cap approved any string under 512 characters — so a
   *  410-character caller-controlled value travelled verbatim under a name that
   *  promised a classification. The VALUE is checked now, against core's
   *  `vendoErrorCodeSchema` rather than a re-listing that could drift from it. */
  it("passes a real VendoErrorCode, and shapes a long non-union string under that key", () => {
    expect(dataOf({ errorCode: "validation" })).toEqual({ errorCode: "validation" });
    expect(dataOf({ errorCode: "x".repeat(410) })).toEqual({ errorCode: "string" });
  });
});

describe("a snapshot ref the Cloud adapter cannot decode", () => {
  /** The failure path is the ONLY path that reports a ref, and a ref that
   *  failed to decode is by definition not one Vendo minted — it is whatever
   *  the caller passed to a public method. Echoing it back, even truncated,
   *  puts caller content on the wire. */
  const methods = ["resume", "destroy"] as const;
  /** Two shapes of hostile input. The scheme-shaped one matters because the
   *  decoder's own message names an unrecognised scheme, and that message is
   *  what this log line carries — so a caller who spells their secret like a
   *  URI scheme would ride the sentence into telemetry. */
  const hostile = [
    ["no recognised scheme", "SECRET=caller-controlled-telemetry-content", (m: string) => `oops ${m}`],
    ["a scheme-shaped value", "zzsecretleakzz", (m: string) => `${m}:payload`],
  ] as const;

  it.each(methods.flatMap((method) => hostile.map((h) => [method, ...h] as const)))(
    "keeps caller content out of telemetry from %s(), given %s",
    async (method, _shape, marker, build) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const seen = reported();
      setLogger(withSdkErrorReporting(consoleLogger));
      const adapter = cloudSandbox({
        apiKey: "vnd_test",
        fetch: (() => {
          throw new Error("an undecodable ref must never reach the console");
        }) as unknown as typeof fetch,
      });

      const ref = build(marker);
      await expect(adapter[method](ref)).rejects.toMatchObject({ code: "validation" });

      const errors = seen.filter((usage) => usage.name === "sdk_error");
      expect(errors).toHaveLength(1);
      // The WHOLE event — `message` included, not just `data`.
      expect(JSON.stringify(errors[0])).not.toContain(marker);
      // Scheme and length are the whole projection, from Vendo's own
      // vocabulary, never a slice of the input.
      expect((errors[0] as { data: Record<string, unknown> }).data).toEqual({
        snapshotRefScheme: "(no known scheme)",
        snapshotRefLength: ref.length,
      });
    },
  );

  /** No digest, ever. An unkeyed hash of caller content is a confirmation
   *  oracle — hash your candidate secrets offline and compare — and hashing an
   *  unbounded argument on a public failure path is a free CPU sink. Losing
   *  cross-report correlation is the accepted trade; this pins it so a re-add
   *  fails a test rather than a review. */
  it("emits no digest of the ref under any key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen = reported();
    setLogger(withSdkErrorReporting(consoleLogger));
    const adapter = cloudSandbox({ apiKey: "vnd_test", fetch: (() => {
      throw new Error("unreachable");
    }) as unknown as typeof fetch });

    const secret = "vendo:v2:correct-horse-battery-staple";
    await expect(adapter.resume(secret)).rejects.toMatchObject({ code: "validation" });

    const { data } = seen.filter((usage) => usage.name === "sdk_error")[0] as {
      data: Record<string, unknown>;
    };
    // The exact key set: a re-added digest fails here whatever it is called...
    expect(Object.keys(data)).toEqual(["snapshotRefScheme", "snapshotRefLength"]);
    // ...and nothing emitted may look like a hash, whatever key carries it.
    for (const value of Object.values(data)) {
      expect(String(value)).not.toMatch(/^[0-9a-f]{8,}$/);
    }
  });

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
