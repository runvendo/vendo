/**
 * Contract test for the Thesys C1 adapter against the recorded fixture
 * (real live traffic, 2026-07-26 — see the fixture's _note). The fixture plays
 * back through the real openai client via its fetch seam; no live API calls,
 * ever.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { C1_MODEL, createThesysC1Adapter, type ThesysC1Raw } from "./thesys-c1";
import type { HostFixture } from "../runner/types";
import { stubHostFixture } from "../fixtures/stub";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "thesys-c1.recorded.json"), "utf8"),
) as { toolCallCompletion: unknown; finalCompletion: unknown };

const host: HostFixture = stubHostFixture("maple", {
  tools: [{ name: "host_listAccounts", description: "List the user's accounts", risk: "low" }],
  execute: vi.fn(async () => [{ id: "a1", name: "Everyday Checking", balance: 4280.12 }]),
});

/** Replays recorded completions in order, recording each request body.
 *  Status 201 is what the live endpoint actually answers with. */
function fetchFromScript(completions: unknown[], requests: unknown[] = []): typeof fetch {
  let call = 0;
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")));
    const body = completions[Math.min(call, completions.length - 1)];
    call += 1;
    return new Response(JSON.stringify(body), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("thesys-c1 adapter", () => {
  beforeEach(() => {
    process.env.THESYS_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.THESYS_API_KEY;
    delete process.env.THESYS_C1_MODEL;
    vi.restoreAllMocks();
  });

  it("returns no-key without THESYS_API_KEY", async () => {
    delete process.env.THESYS_API_KEY;
    const adapter = createThesysC1Adapter({ fetch: fetchFromScript([]) });
    await expect(adapter.generate("hi", host)).resolves.toEqual({ status: "no-key" });
  });

  it("parses the recorded fixture into an ok LaneResult, executing host tools through the fixture", async () => {
    const requests: unknown[] = [];
    const adapter = createThesysC1Adapter({
      fetch: fetchFromScript([fixture.toolCallCompletion, fixture.finalCompletion], requests),
    });
    const result = await adapter.generate("show my account balances at a glance", host);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const raw = result.raw as ThesysC1Raw;
    // The generated UI is C1's envelope around a fenced openui-lang program;
    // the adapter must hand it to their C1Component envelope and all.
    expect(raw.c1Response).toMatch(/^<content thesys="true" version="2">/);
    expect(raw.c1Response).toContain("```openui-lang");
    expect(raw.c1Response).toContain("root = Card(");
    expect(raw.c1Response.trimEnd()).toMatch(/<\/content>$/);
    expect(raw.model).toBe(C1_MODEL);
    expect((requests[0] as { model: string }).model).toBe(C1_MODEL);
    // The runTools loop routed the model's tool call to the fixture executor.
    expect(host.execute).toHaveBeenCalledWith("host_listAccounts", {});
    // Full conversation captured for the internals drawer.
    expect(Array.isArray(raw.messages)).toBe(true);
    expect(raw.messages.length).toBeGreaterThanOrEqual(3); // user, assistant tool call, tool result, final
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("THESYS_C1_MODEL overrides the pinned model (C1's catalog is multi-provider)", async () => {
    process.env.THESYS_C1_MODEL = "c1/openai/gpt-5.2/v-20251230";
    const requests: unknown[] = [];
    const adapter = createThesysC1Adapter({
      fetch: fetchFromScript([fixture.finalCompletion], requests),
    });
    const result = await adapter.generate("hi", host);
    expect(result.status).toBe("ok");
    expect((requests[0] as { model: string }).model).toBe("c1/openai/gpt-5.2/v-20251230");
  });

  it("never throws: transport errors become status failed", async () => {
    const boom = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const adapter = createThesysC1Adapter({ fetch: boom });
    const result = await adapter.generate("hi", host);
    expect(result.status).toBe("failed");
    // The openai client wraps transport failures as APIConnectionError.
    if (result.status === "failed") expect(result.error).toMatch(/connection error/i);
  });
});
