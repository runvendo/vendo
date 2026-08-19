import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// VENDO_STORE_TRACE's line is a MEASUREMENT, so its numbers are the behavior
// under test — a line that prints a plausible-looking millisecond count is worse
// than no line, because it is believed. The one it used to print folded the
// retry's backoff and its own second body read into the door's latency, so a
// healthy 54ms door read as 2.1s. These cases pin the split that fixed it.

const ENGINE_COLLECTION = "vendo_workspace_commits";

/** The client, imported AFTER the switch is set: the flag is read ONCE at
 * import (a debug switch belongs to the process, not to a call), so a fresh
 * module registry is the only way to observe both states in one file. */
const opsWith = async (fetchImpl: typeof fetch, trace = true) => {
  vi.stubEnv("VENDO_STORE_TRACE", trace ? "1" : undefined);
  vi.resetModules();
  const { hostedStoreOps } = await import("../src/hosted-store.js");
  return hostedStoreOps({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: fetchImpl });
};

/** `op=engine.get net=3 total=1004 …` → the fields, by name. */
const fields = (line: string): Record<string, string> =>
  Object.fromEntries(line.split(" ").slice(1).map((pair) => pair.split("=") as [string, string]));

describe("VENDO_STORE_TRACE", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  const lines = (): string[] => stderr.mock.calls
    .map(([first]) => String(first))
    .filter((line) => line.startsWith("vendo-store-trace "));

  beforeEach(() => {
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stderr.mockRestore();
    vi.unstubAllEnvs();
  });

  it("charges the backoff to total and not to the wire, and counts the retry", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      // The console's own "come back in a second" — the wait that used to be
      // reported as the store being slow.
      if (attempts === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
      return Response.json({ record: null }, { headers: { "content-length": "15" } });
    }) as unknown as typeof fetch;

    const ops = await opsWith(fetchImpl);
    expect(await ops.engine.get(ENGINE_COLLECTION, "wsc_1")).toBeNull();

    expect(lines()).toHaveLength(1);
    const line = fields(lines()[0]!);
    expect(line).toMatchObject({ op: "engine.get", retried: "1", bytes: "15", outcome: "ok" });
    // Both attempts really happened, and both were fast: the second the caller
    // spent asleep shows up in `total` alone.
    expect(Number(line.net)).toBeLessThan(500);
    expect(Number(line.total)).toBeGreaterThanOrEqual(900);
  });

  it("does not charge the door for the body — the size is the one the server declared", async () => {
    // A body that arrives slowly, and only when someone reads it. The old line
    // awaited a full `clone().arrayBuffer()` inside its own timed span, so this
    // transfer was billed to the door TWICE.
    const trickle = () => new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ record: null })));
        controller.close();
      },
    });
    const ops = await opsWith((async () => new Response(trickle(), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch);

    const started = Date.now();
    expect(await ops.engine.get(ENGINE_COLLECTION, "wsc_1")).toBeNull();

    // The caller waited for the bytes; the door is not blamed for them.
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    const line = fields(lines()[0]!);
    expect(Number(line.total)).toBeLessThan(200);
    // Nothing was read to find the size out, so an undeclared one stays unknown.
    expect(line).toMatchObject({ retried: "0", bytes: "?", outcome: "ok" });
  });

  it("traces a refusal with the server's code, and prints nothing at all when unset", async () => {
    const refuse = (async () => Response.json({ error: { code: "conflict", message: "taken" } }, { status: 409 })
    ) as unknown as typeof fetch;

    const traced = await opsWith(refuse);
    await expect(traced.engine.put(ENGINE_COLLECTION, { id: "wsc_1", data: {} }))
      .rejects.toMatchObject({ code: "conflict" });
    // A refusal is an answer, so it is never replayed — and its body is already
    // spent on building the error.
    expect(fields(lines()[0]!)).toMatchObject({ retried: "0", bytes: "?", outcome: "conflict" });

    stderr.mockClear();
    const untraced = await opsWith(refuse, false);
    await expect(untraced.engine.put(ENGINE_COLLECTION, { id: "wsc_1", data: {} })).rejects.toThrow();
    expect(lines()).toEqual([]);
  });
});
