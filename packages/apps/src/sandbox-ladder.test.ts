/**
 * THE sandbox ladder — the only copy of "which SandboxAdapter composes", shared
 * by the umbrella (`createVendo({ sandbox })`) and the standalone agent runtime
 * (`agent({ sandbox })`).
 *
 * Every rung here is a promise the docs make to an operator, and each one is a
 * different way to get a deployment silently wrong: a Vendo key shadowing an
 * existing E2B account, a half-installed BYO sandbox riding Cloud instead of
 * saying so, a whitespace key that `vendo doctor` and this function disagree
 * about. So the ladder is tested as a ladder — precedence and all — rather than
 * one rung at a time.
 *
 * The env is driven for real (`vi.stubEnv`) and `e2bInstalled()` really probes
 * the installed `e2b` package: nothing here stubs the thing it is asking about.
 */
import { VendoError } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxAdapter } from "./sandbox.js";
import { selectSandbox, type CloudSandboxRung } from "./sandbox-ladder.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The four env vars the ladder reads. Cleared per case so a developer's own
 *  shell (a real E2B_API_KEY is common) cannot decide the answer. */
const clearLadderEnv = (): void => {
  for (const name of ["E2B_API_KEY", "VENDO_API_KEY", "VENDO_CLOUD_URL", "VENDO_E2B_TIMEOUT_MS", "VENDO_BOX_EDIT_TIMEOUT_MS"]) {
    vi.stubEnv(name, "");
  }
};

/** A host's own adapter. Never called — the ladder only chooses. */
const hostAdapter = { create: null, resume: null, destroy: null } as unknown as SandboxAdapter;

/** The Cloud rung, as composition passes it: a factory over the console
 *  credential, recording what it was handed. */
const cloudRung = (): CloudSandboxRung & { calls: Array<{ apiKey: string; baseUrl?: string }> } => {
  const calls: Array<{ apiKey: string; baseUrl?: string }> = [];
  const rung = (options: { apiKey: string; baseUrl?: string }): SandboxAdapter => {
    calls.push(options);
    return { create: null, resume: null, destroy: null } as unknown as SandboxAdapter;
  };
  return Object.assign(rung, { calls });
};

describe("rung 1 — an explicitly passed adapter always wins (the hard BYO rule)", () => {
  it("returns the host's own adapter as the custom venue", () => {
    clearLadderEnv();
    expect(selectSandbox(hostAdapter)).toEqual({ adapter: hostAdapter, venue: "custom" });
  });

  it("wins over E2B_API_KEY", () => {
    clearLadderEnv();
    vi.stubEnv("E2B_API_KEY", "e2b_key");

    expect(selectSandbox(hostAdapter).venue).toBe("custom");
  });

  it("wins over VENDO_API_KEY and the Cloud rung", () => {
    clearLadderEnv();
    vi.stubEnv("VENDO_API_KEY", "vendo_key");
    const cloud = cloudRung();

    expect(selectSandbox(hostAdapter, cloud).venue).toBe("custom");
    // Not merely outranked — the Cloud rung was never even constructed.
    expect(cloud.calls).toEqual([]);
  });
});

describe("rung 2 — E2B_API_KEY, the BYO sandbox env", () => {
  it("composes the e2b adapter and reports the e2b venue", () => {
    clearLadderEnv();
    vi.stubEnv("E2B_API_KEY", "e2b_key");

    const selection = selectSandbox(undefined);

    expect(selection.venue).toBe("e2b");
    expect(selection.adapter).toBeDefined();
  });

  it("beats VENDO_API_KEY, so a Vendo key never shadows an existing provider account", () => {
    clearLadderEnv();
    vi.stubEnv("E2B_API_KEY", "e2b_key");
    vi.stubEnv("VENDO_API_KEY", "vendo_key");
    const cloud = cloudRung();

    expect(selectSandbox(undefined, cloud).venue).toBe("e2b");
    expect(cloud.calls).toEqual([]);
  });

  it("does NOT treat a whitespace-only key as a key — the same trim `vendo doctor` does", () => {
    // Disagreeing with doctor's E-LIVE-007 about whether the operator set a key
    // means one of the two is lying to the operator.
    clearLadderEnv();
    vi.stubEnv("E2B_API_KEY", "   ");

    expect(selectSandbox(undefined).venue).toBe(false);
  });

  it("falls to Cloud when the E2B key is whitespace, rather than refusing", () => {
    clearLadderEnv();
    vi.stubEnv("E2B_API_KEY", "  \t ");
    vi.stubEnv("VENDO_API_KEY", "vendo_key");

    expect(selectSandbox(undefined, cloudRung()).venue).toBe("cloud");
  });
});

describe("rung 2's machine lifetime knobs", () => {
  // Not observable on the selection object, so these assert the ladder ACCEPTS
  // each spelling and still lands on e2b — the regression they guard is a throw
  // or a dropped rung from a malformed value, not a specific timeout number.
  const e2bWith = (env: Record<string, string>): ReturnType<typeof selectSandbox> => {
    clearLadderEnv();
    vi.stubEnv("E2B_API_KEY", "e2b_key");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    return selectSandbox(undefined);
  };

  it("takes an explicit VENDO_E2B_TIMEOUT_MS", () => {
    expect(e2bWith({ VENDO_E2B_TIMEOUT_MS: "900000" }).venue).toBe("e2b");
  });

  it("derives a machine lifetime from a raised box-edit budget", () => {
    expect(e2bWith({ VENDO_BOX_EDIT_TIMEOUT_MS: "600000" }).venue).toBe("e2b");
  });

  it("ignores a non-numeric or non-positive knob instead of throwing", () => {
    expect(e2bWith({ VENDO_E2B_TIMEOUT_MS: "not-a-number" }).venue).toBe("e2b");
    expect(e2bWith({ VENDO_E2B_TIMEOUT_MS: "0" }).venue).toBe("e2b");
    expect(e2bWith({ VENDO_BOX_EDIT_TIMEOUT_MS: "-1" }).venue).toBe("e2b");
  });
});

describe("rung 3 — VENDO_API_KEY defaults the Cloud managed pool", () => {
  it("builds the Cloud rung with the console credential", () => {
    clearLadderEnv();
    vi.stubEnv("VENDO_API_KEY", "vendo_key");
    const cloud = cloudRung();

    const selection = selectSandbox(undefined, cloud);

    expect(selection.venue).toBe("cloud");
    expect(selection.adapter).toBeDefined();
    expect(cloud.calls).toEqual([{ apiKey: "vendo_key" }]);
  });

  it("passes VENDO_CLOUD_URL through when the operator set one", () => {
    clearLadderEnv();
    vi.stubEnv("VENDO_API_KEY", "vendo_key");
    vi.stubEnv("VENDO_CLOUD_URL", "https://console.example.test");
    const cloud = cloudRung();

    selectSandbox(undefined, cloud);

    expect(cloud.calls).toEqual([{ apiKey: "vendo_key", baseUrl: "https://console.example.test" }]);
  });

  it("omits baseUrl entirely rather than passing undefined", () => {
    clearLadderEnv();
    vi.stubEnv("VENDO_API_KEY", "vendo_key");
    const cloud = cloudRung();

    selectSandbox(undefined, cloud);

    expect(Object.keys(cloud.calls[0] ?? {})).toEqual(["apiKey"]);
  });

  it("does not light at all in a build with no Cloud adapter", () => {
    // The Cloud rung ships in @vendoai/vendo, which this package may not import,
    // so it is a parameter. Unset, a Vendo key buys no sandbox.
    clearLadderEnv();
    vi.stubEnv("VENDO_API_KEY", "vendo_key");

    expect(selectSandbox(undefined)).toEqual({ adapter: undefined, venue: false });
  });
});

describe("rung 4 — nothing", () => {
  it("answers with no adapter and no venue, leaving the meaning to the caller", () => {
    clearLadderEnv();

    expect(selectSandbox(undefined)).toEqual({ adapter: undefined, venue: false });
  });

  it("answers the same when a Cloud rung exists but no key does", () => {
    clearLadderEnv();
    const cloud = cloudRung();

    expect(selectSandbox(undefined, cloud)).toEqual({ adapter: undefined, venue: false });
    expect(cloud.calls).toEqual([]);
  });
});

describe("half a BYO sandbox is a MISCONFIG, not a fallback (0.4.4 defect C)", () => {
  it("refuses at boot when E2B_API_KEY is set but the e2b package is absent", () => {
    // The probe is `e2bInstalled(specifier)` over the real module resolver, so
    // an absent package is spelled here the honest way — by asking about one
    // that genuinely is not installed — rather than by stubbing the probe.
    clearLadderEnv();
    vi.stubEnv("E2B_API_KEY", "e2b_key");

    const attempt = (): unknown => selectSandbox(undefined, cloudRung(), "e2b-not-a-real-package");

    expect(attempt).toThrow(VendoError);
    expect(attempt).toThrow(/E2B_API_KEY is set but the e2b package is not installed/);
    // The remedy names BOTH ways out, because either is legitimate.
    expect(attempt).toThrow(/install e2b/);
    expect(attempt).toThrow(/unset E2B_API_KEY/);
  });

  it("does NOT quietly fall through to Cloud when the install is missing", () => {
    clearLadderEnv();
    vi.stubEnv("E2B_API_KEY", "e2b_key");
    vi.stubEnv("VENDO_API_KEY", "vendo_key");
    const cloud = cloudRung();

    expect(() => selectSandbox(undefined, cloud, "e2b-not-a-real-package")).toThrow(VendoError);
    // Silently riding Cloud is exactly the defect: it hides the missing install
    // until the first box boot dies somewhere else entirely.
    expect(cloud.calls).toEqual([]);
  });
});
