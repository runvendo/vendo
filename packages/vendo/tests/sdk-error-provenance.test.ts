import type { VendoUsageEvent } from "@vendoai/core";
import { consoleLogger, setLogger, setUsageSink } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudSandbox } from "../src/sandbox.js";
import { withSdkErrorReporting } from "../src/sdk-events.js";

/**
 * What `sdk_error.data` is allowed to say. CLASSIFICATION ONLY: no
 * caller-influenced value leaves the customer's servers, so the one question a
 * candidate key has to answer is whether a CALLER CAN INFLUENCE ITS VALUE — not
 * whether its name sits in Vendo's namespace. A classification against a
 * Vendo-authored closed set travels; every other value travels as its shape,
 * and so does every key nobody has allowlisted, which is the property that
 * keeps a log site added tomorrow from leaking by default.
 *
 * `appId` and `turnId` are the worked examples, and the reason the name is not
 * the test: both are spelled in Vendo's own id namespace, and both are supplied
 * by the caller on a live path, so both report their type and nothing else. A
 * value that failed to decode is the caller's input for the same reason —
 * classified against a closed set, never echoed, not even a prefix of it. That
 * distinction is what the marker cases below hold in place.
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

  /** The cap is a VOLUME gate on the passthrough, independent of what the key
   *  means: `data` is `Record<string, unknown>`, so an allowlisted key CAN be
   *  handed something unbounded, and when it is, the shape travels instead. */
  it("falls back to the shape when an allowlisted value exceeds the length cap", () => {
    const atCap = "a".repeat(512);
    expect(dataOf({ errorCode: atCap })).toEqual({ errorCode: atCap });
    expect(dataOf({ errorCode: `${atCap}a` })).toEqual({ errorCode: "string" });
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
