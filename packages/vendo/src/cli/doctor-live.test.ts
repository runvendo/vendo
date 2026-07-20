import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  cloudDoctor,
  CLOUD_UNLOCKS,
  liveModelTurn,
  startDevServerForProbe,
} from "./doctor-live.js";

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
});
