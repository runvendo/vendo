import { describe, it, expect, vi } from "vitest";
import { createTelemetry } from "./client.js";

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    version: "9.9.9",
    home: undefined as string | undefined,
    config: { anonymousId: "id-1", optedOut: false, noticeShown: true },
    env: {} as Record<string, string | undefined>,
    runtime: false,
    posthogKey: "phc_test",
    fetchImpl: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

describe("createTelemetry.track", () => {
  it("posts an allowlisted event to PostHog", async () => {
    const deps = makeDeps();
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next" });
    expect(deps.fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = deps.fetchImpl.mock.calls[0];
    expect(String(url)).toContain("us.i.posthog.com");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.api_key).toBe("phc_test");
    expect(body.event).toBe("init_started");
    expect(body.distinct_id).toBe("id-1");
    expect(body.properties.framework).toBe("next");
    expect(body.properties.vendoVersion).toBe("9.9.9");
  });

  it("does not post when consent is denied", async () => {
    const deps = makeDeps({ env: { DO_NOT_TRACK: "1" } });
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next" });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("does not post when no PostHog key is configured", async () => {
    const deps = makeDeps({ posthogKey: undefined });
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next" });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("drops keys outside the event allowlist", async () => {
    const deps = makeDeps();
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next", sourceCode: "secret" } as never);
    const body = JSON.parse((deps.fetchImpl.mock.calls[0][1] as { body: string }).body);
    expect(body.properties.sourceCode).toBeUndefined();
    expect(body.properties.framework).toBe("next");
  });

  it("never throws when fetch rejects", async () => {
    const deps = makeDeps({ fetchImpl: vi.fn().mockRejectedValue(new Error("network")) });
    const t = createTelemetry(deps);
    await expect(t.track("agent_run", {})).resolves.toBeUndefined();
  });
});
