/**
 * Contract test for the Tambo adapter against the fixture recorded from a real
 * 2026-07-26 run (see the fixture's _note). The recorded thread plays back
 * through the real extraction path via the run seam; no live API calls, ever.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTamboAdapter, type TamboRaw, type TamboThreadLike } from "./tambo";
import type { HostFixture } from "../runner/types";
import { stubHostFixture } from "../fixtures/stub";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "tambo.recorded.json"), "utf8"),
) as { thread: TamboThreadLike };

const host: HostFixture = stubHostFixture("maple", {
  tools: [{ name: "host_listAccounts", description: "List the user's accounts", risk: "low" }],
  execute: vi.fn(async () => []),
});

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
    // Live shape: one component block per assistant message, chart then table.
    expect(raw.components.map((pick) => pick.name)).toEqual(["chart", "table"]);
    expect(raw.components[0].props).toMatchObject({ title: "Account balances" });
    expect(raw.text).toContain("balances at a glance");
    // Full thread preserved for the internals drawer.
    expect(raw.thread.messages).toHaveLength(5);
  });

  it("strips Tambo's own display metadata out of the component props", async () => {
    const adapter = createTamboAdapter({ run: async () => fixture.thread });
    const result = await adapter.generate("show my account balances at a glance", host);
    if (result.status !== "ok") throw new Error("expected ok");
    for (const pick of (result.raw as TamboRaw).components) {
      expect(Object.keys(pick.props).filter((key) => key.startsWith("_tambo_"))).toEqual([]);
    }
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
