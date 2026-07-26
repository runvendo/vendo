import { describe, expect, it, vi } from "vitest";
import { pickGenerationBeat, renderGateReport, waitForDeployedReady } from "./gate.js";

describe("pickGenerationBeat", () => {
  const beats = [
    { key: "take-action", prompt: "Close it", chip: "Close", expectsApproval: true },
    { key: "generate-ui", prompt: "Build me a board", chip: "Board", expectsView: true },
  ];

  it("prefers the declared expectsView beat", () => {
    expect(pickGenerationBeat(beats).key).toBe("generate-ui");
  });

  it("falls back to the first beat and rejects an empty list", () => {
    expect(pickGenerationBeat([{ key: "x", prompt: "p", chip: "c" }]).key).toBe("x");
    expect(() => pickGenerationBeat([])).toThrow("no beats");
  });
});

describe("waitForDeployedReady", () => {
  it("returns only once the app answers 200 — Railway's mid-build 404 is not ready", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(waitForDeployedReady("https://demos.vendo.run/linear", { fetchImpl, pollMs: 1, timeoutMs: 5_000 }))
      .resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("times out with the URL and the last failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 502 }));
    await expect(waitForDeployedReady("https://demos.vendo.run/linear", { fetchImpl, pollMs: 1, timeoutMs: 25 }))
      .rejects.toThrow(/demos\.vendo\.run\/linear.*HTTP 502/s);
  });
});

describe("renderGateReport", () => {
  it("marks the verdict from the steps", () => {
    const pass = renderGateReport({
      demoUrl: "https://demos.vendo.run/linear",
      steps: [{ step: "login", ok: true, detail: "no login wall" }],
    });
    expect(pass).toContain("**PASS**");
    const fail = renderGateReport({
      demoUrl: "https://demos.vendo.run/linear",
      steps: [{ step: "scenario-cards", ok: false, detail: "missing beat cards: generate-ui" }],
    });
    expect(fail).toContain("NOT done");
    expect(fail).toContain("missing beat cards");
  });
});
