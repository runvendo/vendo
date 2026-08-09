import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  cloudDoctor,
  CLOUD_UNLOCKS,
  liveModelTurn,
  startDevServerForProbe,
} from "../../src/cli/doctor-live.js";

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

  it("surfaces the agent's safe error frame verbatim — the meter-exhausted refusal reads like the banner", async () => {
    const refusal =
      "Vendo: Vendo Cloud paused AI tokens — the allowance for this billing period is used up "
      + "(1,204,000 of 1,000,000 used; resets 2026-08-01). "
      + "Upgrade your plan (https://console.vendo.run/billing) "
      + "or bring your own infrastructure (https://docs.vendo.run/byo). (cloud-required)";
    const fetchImpl = vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ type: "error", errorText: refusal })}\n\n`,
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;
    const result = await liveModelTurn({ base: "http://x/api/vendo", fetchImpl, env });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(refusal.slice("Vendo: ".length));
  });

  it("strips control characters and caps length before printing a Vendo error frame (terminal hardening)", async () => {
    const hostile = `Vendo: \u001b[2K\u0007meter refused ${"x".repeat(400)} (cloud-required)`;
    const fetchImpl = vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ type: "error", errorText: hostile })}\n\n`,
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;
    const result = await liveModelTurn({ base: "http://x/api/vendo", fetchImpl, env });
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("\u001b");
    expect(result.error).not.toContain("\u0007");
    expect(result.error?.startsWith("[2Kmeter refused x")).toBe(true);
    expect(result.error?.length).toBe(300);
  });

  it("keeps the generic line for a non-Vendo error frame (raw errorText never surfaces)", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([
      'data: {"type":"error","errorText":"ECONNRESET at https://provider.internal/key=sk-123"}\n\n',
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;
    const result = await liveModelTurn({ base: "http://x/api/vendo", fetchImpl, env });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("the turn returned an error frame");
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

  it("flags a malformed key locally", async () => {
    const result = await cloudDoctor({ env: { VENDO_API_KEY: "nope" } });
    expect(result.present).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("malformed");
  });

  it("accepts a well-formed key", async () => {
    const result = await cloudDoctor({ env: { VENDO_API_KEY: `vnd_${"a".repeat(40)}` } });
    expect(result).toEqual({ present: true, ok: true, unlocks: CLOUD_UNLOCKS });
  });
});

describe("startDevServerForProbe", () => {
  it("degrades to ok:false when the spawn itself fails (package manager missing from PATH)", async () => {
    // A lockfile-derived package manager that is not installed makes spawn emit
    // 'error' (ENOENT); with no listener that crashes the whole doctor process.
    const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
    (child as unknown as { kill: () => void }).kill = vi.fn();
    const fetchImpl = vi.fn(async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
    const started = await startDevServerForProbe({
      root: "/nonexistent/vendo-doctor-spawn-test",
      statusUrl: "http://localhost:3000/api/vendo",
      fetchImpl,
      timeoutMs: 10_000,
      spawnDev: () => {
        setImmediate(() => child.emit("error", new Error("spawn yarn ENOENT")));
        return child;
      },
    });
    expect(started.ok).toBe(false);
    expect(started.log.join("")).toContain("spawn yarn ENOENT");
  });

  it("stops polling as soon as the spawn fails, so doctor exits with its verdict", async () => {
    // The status poll is the only thing left holding node's event loop after
    // doctor prints — bin/vendo.mjs sets process.exitCode and never calls
    // process.exit(). A poll that outlives the spawn failure hangs the CLI for
    // the whole timeout.
    const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
    (child as unknown as { kill: () => void }).kill = vi.fn();
    const fetchImpl = vi.fn(async () => { throw new Error("connection refused"); });
    const started = await startDevServerForProbe({
      root: "/nonexistent/vendo-doctor-spawn-test",
      statusUrl: "http://localhost:3000/api/vendo",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 60_000,
      spawnDev: () => {
        setImmediate(() => child.emit("error", new Error("spawn yarn ENOENT")));
        return child;
      },
    });
    expect(started.ok).toBe(false);

    const pollsAtReturn = fetchImpl.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1_700)); // two poll intervals
    expect(fetchImpl.mock.calls.length).toBe(pollsAtReturn);
  });
});
