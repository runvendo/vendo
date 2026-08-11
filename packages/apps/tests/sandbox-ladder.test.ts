/**
 * THE sandbox ladder — the only copy of "which SandboxAdapter composes", shared
 * by the umbrella (`createVendo({ sandbox })`) and the standalone agent runtime
 * (`agent({ sandbox })`).
 *
 * Every rung here is a promise the docs make to an operator, and each one is a
 * different way to get a deployment silently wrong. The biggest one is gone
 * since the SELECTION LAW: E2B_API_KEY is a credential, not a rung, so a key
 * lying in a shell can no longer choose a deployment's execution venue. What is
 * left is short enough to state in one line — explicit adapter, VENDO_API_KEY,
 * dark — and it is still tested as a ladder, precedence and all, because the
 * precedence is the promise.
 *
 * The env is driven for real (`vi.stubEnv`); nothing here stubs the thing it is
 * asking about.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxAdapter } from "../src/server/escalation/sandbox.js";
import { selectSandbox, type CloudSandboxRung } from "../src/server/escalation/sandbox-ladder.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Every env var this file speaks about — the two the ladder still reads, plus
 *  the ones it deliberately no longer does. Cleared per case so a developer's own
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

describe("E2B_API_KEY is a CREDENTIAL, not a rung (the selection law)", () => {
  // The breaking change, stated as tests. Before this, a key left in a shell —
  // or inherited by a container — selected the e2b venue for the whole
  // deployment, which is how 0.4.4 defect C shipped: nobody wrote it down, so
  // nobody could see it was wrong.
  it("a stray E2B_API_KEY selects nothing at all — the venue stays dark", () => {
    clearLadderEnv();
    vi.stubEnv("E2B_API_KEY", "e2b_key");

    expect(selectSandbox(undefined)).toEqual({ adapter: undefined, venue: false });
  });

  it("a stray E2B_API_KEY does NOT outrank VENDO_API_KEY — Cloud fills the unset slot", () => {
    clearLadderEnv();
    vi.stubEnv("E2B_API_KEY", "e2b_key");
    vi.stubEnv("VENDO_API_KEY", "vendo_key");
    const cloud = cloudRung();

    expect(selectSandbox(undefined, cloud).venue).toBe("cloud");
    expect(cloud.calls).toEqual([{ apiKey: "vendo_key" }]);
  });

  it("no shape of E2B_API_KEY changes the answer — set, whitespace, or empty", () => {
    for (const value of ["e2b_key", "   ", "  \t ", ""]) {
      clearLadderEnv();
      vi.stubEnv("E2B_API_KEY", value);
      expect(selectSandbox(undefined).venue, value).toBe(false);

      clearLadderEnv();
      vi.stubEnv("E2B_API_KEY", value);
      vi.stubEnv("VENDO_API_KEY", "vendo_key");
      expect(selectSandbox(undefined, cloudRung()).venue, value).toBe("cloud");
    }
  });

  it("neither do the e2b machine-lifetime knobs, which are the adapter's business now", () => {
    // VENDO_E2B_TIMEOUT_MS / VENDO_BOX_EDIT_TIMEOUT_MS moved into e2bSandbox()
    // with the credential (tests/e2b/e2b.test.ts asserts the real timeout they
    // produce). Here they must not resurrect a rung.
    for (const knob of ["VENDO_E2B_TIMEOUT_MS", "VENDO_BOX_EDIT_TIMEOUT_MS"]) {
      clearLadderEnv();
      vi.stubEnv("E2B_API_KEY", "e2b_key");
      vi.stubEnv(knob, "900000");
      expect(selectSandbox(undefined).venue, knob).toBe(false);
    }
  });
});

describe("rung 2 — VENDO_API_KEY defaults the Cloud managed pool", () => {
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

describe("rung 3 — nothing", () => {
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

  it("never throws — the ladder has no misconfiguration left to refuse", () => {
    // Half a BYO sandbox (0.4.4 defect C) used to be refused HERE, because the
    // env chose the venue. It is refused in e2bSandbox() now, where the host
    // actually asked for e2b (tests/e2b/e2b.test.ts). Selection itself is total.
    clearLadderEnv();
    vi.stubEnv("E2B_API_KEY", "e2b_key");
    vi.stubEnv("VENDO_API_KEY", "vendo_key");

    expect(() => selectSandbox(undefined)).not.toThrow();
    expect(() => selectSandbox(undefined, cloudRung())).not.toThrow();
  });
});
