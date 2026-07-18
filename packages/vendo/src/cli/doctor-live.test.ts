import { describe, expect, it, vi } from "vitest";
import {
  cloudDoctor,
  CLOUD_UNLOCKS,
  liveModelTurn,
} from "./doctor-live.js";
import type { ContractV2 } from "./cloud/entitlements.js";

function sseResponse(frames: string[]): Response {
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}

describe("liveModelTurn", () => {
  const env = { ANTHROPIC_API_KEY: "sk-test" };

  it("streams a UI-message SSE reply and reports ok with the rung", async () => {
    const deltas: string[] = [];
    const fetchImpl = vi.fn(async () => sseResponse([
      'data: {"type":"text-delta","delta":"Hello "}\n\n',
      'data: {"type":"text-delta","delta":"world"}\n\n',
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;
    const result = await liveModelTurn({
      base: "http://localhost:3000/api/vendo",
      fetchImpl,
      env,
      onDelta: (d) => deltas.push(d),
    });
    expect(result.ok).toBe(true);
    expect(result.reply).toBe("Hello world");
    expect(result.rung).toBe("env-key");
    expect(deltas).toEqual(["Hello ", "world"]);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe("http://localhost:3000/api/vendo/threads");
  });

  it("fails when the stream yields no text", async () => {
    const fetchImpl = vi.fn(async () => sseResponse(["data: [DONE]\n\n"])) as unknown as typeof fetch;
    const result = await liveModelTurn({ base: "http://x/api/vendo", fetchImpl, env });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no reply text");
  });

  it("fails on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const result = await liveModelTurn({ base: "http://x/api/vendo", fetchImpl, env });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("503");
  });

  it("fails gracefully on a network error", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const result = await liveModelTurn({ base: "http://x/api/vendo", fetchImpl, env });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });
});

describe("cloudDoctor", () => {
  it("reports absent + unlocks when no key is set", async () => {
    const result = await cloudDoctor({ env: {} });
    expect(result.present).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.unlocks).toEqual(CLOUD_UNLOCKS);
  });

  it("rejects a malformed key without a network call", async () => {
    const validate = vi.fn();
    const result = await cloudDoctor({ env: { VENDO_API_KEY: "nope" }, validate });
    expect(result.present).toBe(true);
    expect(result.ok).toBe(false);
    expect(validate).not.toHaveBeenCalled();
  });

  it("returns the plan and enabled capabilities for a valid key", async () => {
    const contract: ContractV2 = {
      valid: true,
      contract_version: 2,
      org: { id: "o", name: "Org", slug: "org" },
      plan: { id: "pro", name: "Pro", status: "active" },
      capabilities: {
        sharing: true, registry: false, guard_basic: true, pinning: false,
        guard_full: false, session_replay: false, insights: true, mcp_broker: false,
        sso_saml: false, orgs: true,
      },
      limits: {
        sandbox_minutes: { included: 0, used: 0, remaining: 0, exhausted: false },
        runs: { included: 0, used: 0, remaining: 0, exhausted: false },
        storage_gb: { included: 0, used: 0, remaining: 0, exhausted: false },
      },
      cache: { ttl_seconds: 600, stale_if_error_seconds: 86400 },
    };
    const result = await cloudDoctor({
      env: { VENDO_API_KEY: `vnd_${"a".repeat(40)}` },
      validate: async () => contract,
    });
    expect(result.ok).toBe(true);
    expect(result.plan?.name).toBe("Pro");
    expect(result.capabilities).toEqual(["sharing", "guard_basic", "insights", "orgs"]);
  });

  it("surfaces validation errors without throwing", async () => {
    const result = await cloudDoctor({
      env: { VENDO_API_KEY: `vnd_${"a".repeat(40)}` },
      validate: async () => { throw new Error("401 invalid key"); },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
  });
});
