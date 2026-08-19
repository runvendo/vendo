/**
 * A door that is CONFIGURED but not THERE — the second way this harness could
 * chat with no hands.
 *
 * The no-origin refusal (claude-code.test.ts) only ever saw an UNDEFINED door
 * url. A defined one that 404s sailed straight past it: the Agent SDK swallows a
 * failed MCP connect, the session opens with zero `mcp__*` tools, and the model
 * answers anyway — the polite-refusal-at-HTTP-200 the refusal above exists to
 * prevent, arriving through a different hole. Observed live on a deployment
 * served under a path prefix, where the door url dropped it (`POST
 * /api/vendo/mcp 404`).
 *
 * The doors here are REAL HTTP servers, so the probe under test does a real
 * request and reads a real status — nothing on either side of that seam is a
 * double.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { VendoError, type HarnessEvent, type Turn } from "@vendoai/core";
import { describe, expect, test } from "vitest";
import { createTurnState } from "../../src/harness-state.js";
import { provideHarnessAdapters } from "../../src/harness-sandbox.js";
import { liveDoor, testWorkspace, unusedModels, userMessage } from "../../src/test-doubles.test-util.js";
import { claudeCode } from "../../src/claude-code/index.js";

let seq = 0;

/** The least turn that reaches the door decision — it is taken before the
 *  machine exists, so nothing here needs a box or a session. */
const makeTurn = (signal: AbortSignal = new AbortController().signal): Turn<never> => ({
  threadId: `thr_door_${(seq += 1)}`,
  messages: [userMessage(`m_${seq}`, "make me a dashboard")],
  tools: { list: async () => [], call: async () => ({ status: "ok" as const, output: {} }) },
  skills: { list: async () => [], load: async () => "" },
  workspace: testWorkspace({}),
  models: unusedModels(),
  state: createTurnState(undefined),
  options: {} as never,
  signal,
  interactive: true,
  system: "PRODUCT BRIEF",
} as unknown as Turn<never>);

const drain = async (
  harness: ReturnType<typeof claudeCode>,
  signal?: AbortSignal,
): Promise<HarnessEvent[]> => {
  const events: HarnessEvent[] = [];
  for await (const event of harness.run(makeTurn(signal) as never)) events.push(event);
  return events;
};

/** A door that ACCEPTS the connection and then never answers — the one shape a
 *  status code cannot describe, and the only one that can leave the probe
 *  pending. The socket is held open until the test closes the server. */
async function hangingDoor(): Promise<{ url: string; close: () => Promise<void> }> {
  const held: Array<{ destroy: () => void }> = [];
  const server = createServer((_request, _response) => { /* never answers */ });
  server.on("connection", (socket) => { held.push(socket); });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/vendo/mcp`,
    close: async () => {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
}

/** Both legs, built the same way: a door port pointed wherever the test says. */
const harnessDialling = (
  url: string | undefined,
  options: Parameters<typeof claudeCode>[0] = {},
): ReturnType<typeof claudeCode> => {
  const harness = claudeCode(options);
  provideHarnessAdapters(harness, {
    toolDoor: { url, autoMounted: false, mint: () => "vtk_probe", revoke: () => undefined },
  });
  return harness;
};

describe("a configured door that does not answer — the turn refuses instead of chatting toolless", () => {
  test("SANDBOX leg: a door that 404s fails the turn, naming the url it tried", async () => {
    const door = await liveDoor(404);
    try {
      // Named, reachable as a host, and simply not there — which is exactly
      // what a dropped path prefix produced against a live Next.js server.
      await expect(drain(harnessDialling(door.url, { sandbox: {} as never })))
        .rejects.toThrow(VendoError);
      await expect(drain(harnessDialling(door.url, { sandbox: {} as never })))
        .rejects.toThrow(door.url);
    } finally {
      await door.close();
    }
  });

  test("LOCAL leg: the same refusal — the subprocess reaches the door over the same url", async () => {
    const door = await liveDoor(404);
    try {
      await expect(drain(harnessDialling(door.url, { machine: "local" })))
        .rejects.toThrow(door.url);
    } finally {
      await door.close();
    }
  });

  test("a door nothing is listening on is the SAME refusal — a down host reads to a customer exactly like a wrong path", async () => {
    // Bound, then closed, so the port is real and refuses the connection.
    const door = await liveDoor(404);
    await door.close();
    await expect(drain(harnessDialling(door.url, { sandbox: {} as never })))
      .rejects.toThrow(door.url);
  });

  test("a host that does not resolve is the same refusal — the typo an operator actually makes", async () => {
    await expect(drain(harnessDialling("https://not-a-real-host.invalid/api/vendo/mcp")))
      .rejects.toThrow("not-a-real-host.invalid");
  });

  test("a 401 door is a LIVE door: auth rides the turn credential, which is minted later", async () => {
    const door = await liveDoor(401);
    try {
      // Past the probe, so the next thing it hits is the missing machine — the
      // proof that an unauthenticated 401 was never read as "not there".
      const events = await drain(harnessDialling(door.url));
      expect(events).toContainEqual({
        type: "error",
        message: "I can't run right now — this assistant is missing its workspace machine.",
      });
    } finally {
      await door.close();
    }
  });

  test("a CANCELLED turn stops waiting on a door that never answers, and is not told the door is dead", async () => {
    // The probe is the first thing a turn does, and a door that accepts the
    // connection but never replies holds it open — undici only gives up at its
    // 300s headers timeout. Without the turn's signal the harness stayed pending
    // long after the user cancelled; with it, the fetch is torn down at once.
    // And a cancellation is not a verdict on the door: reporting "no MCP door"
    // here would send an operator hunting a misconfiguration that never existed.
    const hanging = await hangingDoor();
    try {
      const controller = new AbortController();
      setTimeout(() => { controller.abort(); }, 50);

      const started = Date.now();
      const events = await drain(harnessDialling(hanging.url), controller.signal);

      // Settled on the cancellation, not on a network timeout.
      expect(Date.now() - started).toBeLessThan(5_000);
      // It fell through to the missing machine like any other cancelled turn —
      // the door was never blamed.
      expect(events).toContainEqual({
        type: "error",
        message: "I can't run right now — this assistant is missing its workspace machine.",
      });
    } finally {
      await hanging.close();
    }
  });

  test("an UNCONFIGURED door is never probed — the existing refusal answers, unchanged", async () => {
    const events = await drain(harnessDialling(undefined));
    expect(events).toContainEqual({
      type: "error",
      message: "I can't use this product's actions right now.",
    });
  });
});
