/**
 * Contract test for the Tambo adapter against the recorded fixture
 * (hand-authored from the client's type declarations — see the fixture's
 * _note). The fixture thread plays back through the real extraction path via
 * the run seam; no live API calls, ever.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTamboAdapter, type TamboRaw, type TamboThreadLike } from "./tambo";
import type { HostFixture } from "../runner/types";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "tambo.recorded.json"), "utf8"),
) as { thread: TamboThreadLike };

const host: HostFixture = {
  name: "maple",
  catalog: {},
  tools: [{ name: "host_listAccounts", description: "List the user's accounts", risk: "low" }],
  shapes: {},
  theme: {},
  execute: vi.fn(async () => []),
};

describe("tambo adapter", () => {
  beforeEach(() => {
    process.env.TAMBO_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.TAMBO_API_KEY;
    vi.restoreAllMocks();
  });

  it("returns no-key without TAMBO_API_KEY", async () => {
    delete process.env.TAMBO_API_KEY;
    const adapter = createTamboAdapter({ run: async () => fixture.thread });
    await expect(adapter.generate("hi", host)).resolves.toEqual({ status: "no-key" });
  });

  it("parses the recorded thread into component picks + text, keeping the full thread as raw", async () => {
    const run = vi.fn(async () => fixture.thread);
    const adapter = createTamboAdapter({ run });
    const result = await adapter.generate("show my account balances at a glance", host);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(run).toHaveBeenCalledWith("show my account balances at a glance", host, "test-key");
    const raw = result.raw as TamboRaw;
    expect(raw.components).toHaveLength(1);
    expect(raw.components[0].name).toBe("chart");
    expect(raw.components[0].props).toMatchObject({ title: "Account balances" });
    expect(raw.text).toContain("balances at a glance");
    // Full thread preserved for the internals drawer.
    expect(raw.thread.messages).toHaveLength(4);
  });

  it("never throws: client errors become status failed", async () => {
    const adapter = createTamboAdapter({
      run: async () => {
        throw new Error("401 invalid api key");
      },
    });
    const result = await adapter.generate("hi", host);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toContain("invalid api key");
  });
});
