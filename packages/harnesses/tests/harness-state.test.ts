/**
 * Build contract §1.3 — `turn.state` is opaque to us, persisted at turn end,
 * and cleared by the runtime on arbitrary history edits or a harness swap. A
 * prefix truncation uses the harness's native rewind instead, so it must NOT
 * clear: throwing away a Claude Code session id because the user retried an
 * edited message would cost a re-seed for nothing.
 */
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { classifyHistory, createTurnState, memoryHarnessStateStore } from "../src/harness-state.js";
import { userMessage } from "../src/test-doubles.test-util.js";

const assistant = (id: string, text: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
});

describe("createTurnState", () => {
  it("hands the harness back what it stored last turn", () => {
    const state = createTurnState("session_abc");
    expect(state.get()).toBe("session_abc");
  });

  it("set() is visible immediately and marked for persistence", () => {
    const state = createTurnState(undefined);
    expect(state.pending().dirty).toBe(false);
    state.set("session_1");
    expect(state.get()).toBe("session_1");
    expect(state.pending()).toEqual({ value: "session_1", dirty: true });
  });

  it("clear() removes it and is itself a change to persist", () => {
    const state = createTurnState("session_1");
    state.clear();
    expect(state.get()).toBeUndefined();
    expect(state.pending()).toEqual({ value: undefined, dirty: true });
  });

  it("an untouched state is not written back at turn end", () => {
    const state = createTurnState("session_1");
    expect(state.get()).toBe("session_1");
    expect(state.pending().dirty).toBe(false);
  });

  it("the last write of the turn is the one that persists", () => {
    const state = createTurnState(undefined);
    state.set("a");
    state.set("b");
    expect(state.pending()).toEqual({ value: "b", dirty: true });
  });
});

describe("memoryHarnessStateStore — one slot per thread, owned by a harness", () => {
  it("round-trips a value", async () => {
    const store = memoryHarnessStateStore();
    await store.set("thr_1", "vendo", "session_1");
    await expect(store.get("thr_1", "vendo")).resolves.toBe("session_1");
  });

  it("a harness swap CLEARS the thread's state (§1.3), it does not shadow it", async () => {
    const store = memoryHarnessStateStore();
    await store.set("thr_1", "vendo", "session_1");
    await expect(store.get("thr_1", "claude-code")).resolves.toBeUndefined();
    // The swap DESTROYED it: swapping back must not resurrect a session id for a
    // conversation that has since moved on without it.
    await expect(store.get("thr_1", "vendo")).resolves.toBeUndefined();
  });

  it("clear() drops the thread's state whoever owns it", async () => {
    const store = memoryHarnessStateStore();
    await store.set("thr_1", "vendo", "session_1");
    await store.clear("thr_1");
    await expect(store.get("thr_1", "vendo")).resolves.toBeUndefined();
  });

  it("threads never see each other's state", async () => {
    const store = memoryHarnessStateStore();
    await store.set("thr_1", "vendo", "one");
    await expect(store.get("thr_2", "vendo")).resolves.toBeUndefined();
  });

  it("setting undefined deletes", async () => {
    const store = memoryHarnessStateStore();
    await store.set("thr_1", "vendo", "one");
    await store.set("thr_1", "vendo", undefined);
    await expect(store.get("thr_1", "vendo")).resolves.toBeUndefined();
  });
});

describe("classifyHistory", () => {
  const a = userMessage("m1", "hello");
  const b = assistant("m2", "hi there");
  const c = userMessage("m3", "and again");

  it("a first turn is an append", () => {
    expect(classifyHistory([], [a])).toBe("append");
  });

  it("adding messages onto an untouched history is an append", () => {
    expect(classifyHistory([a, b], [a, b, c])).toBe("append");
  });

  it("resending the identical history is an append", () => {
    expect(classifyHistory([a, b], [a, b])).toBe("append");
  });

  it("dropping the tail is a prefix truncation, not an edit", () => {
    expect(classifyHistory([a, b, c], [a, b])).toBe("prefix-truncation");
  });

  it("rewriting an existing message is an arbitrary edit", () => {
    expect(classifyHistory([a, b], [userMessage("m1", "hello, changed"), b])).toBe("arbitrary-edit");
  });

  it("reordering is an arbitrary edit", () => {
    expect(classifyHistory([a, b], [b, a])).toBe("arbitrary-edit");
  });

  it("replacing the tail with a different message is an arbitrary edit", () => {
    expect(classifyHistory([a, b, c], [a, b, userMessage("m9", "different")])).toBe("arbitrary-edit");
  });

  it("deleting from the middle is an arbitrary edit", () => {
    expect(classifyHistory([a, b, c], [a, c])).toBe("arbitrary-edit");
  });

  it("ignores key order inside a part — the wire drops undefined props anyway", () => {
    const left: UIMessage = { id: "m1", role: "user", parts: [{ type: "text", text: "x" }] };
    const right: UIMessage = { role: "user", id: "m1", parts: [{ text: "x", type: "text" }] } as UIMessage;
    expect(classifyHistory([left], [right])).toBe("append");
  });
});
