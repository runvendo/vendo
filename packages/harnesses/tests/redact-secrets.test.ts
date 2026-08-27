/**
 * VEGA-INFO-00021 — a boxed agent holds a REUSABLE inference credential and
 * streams its output to the end user, who can steer it into printing the key.
 * The runtime is the one seam every user-facing part crosses, so it redacts the
 * literal value from BOTH the assistant's prose and any tool output. These tests
 * drive a real turn through the real runtime with the credential set in the
 * environment (the way `inferenceEnv()` reads it) and prove it never reaches the
 * wire verbatim.
 *
 * This is defense in depth, not the fix: a model asked to transform the key
 * first defeats a literal match — the fix is per-session brokering (deferred).
 */
import { defineHarness } from "../src/define.js";
import { type Harness, type ThreadId } from "@vendoai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarnessRuntime } from "../src/runtime.js";
import {
  boundRegistry,
  ctx,
  readSse,
  readTool,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  unusedModels,
  userMessage,
} from "../src/test-doubles.test-util.js";

const THREAD = "thr_1" as ThreadId;
const SECRET = "sk-vendo-live-REDACT_ME_1234567890abcdef";

/** Run one turn through the real runtime and return the SSE parts. */
async function runTurn(
  harness: Harness,
  tools: Parameters<typeof boundRegistry>[0] = {},
): Promise<Array<Record<string, unknown>>> {
  const guard = testGuard();
  const runtime = createHarnessRuntime({
    tools: boundRegistry(tools, guard),
    guard,
    skills: testSkills(),
    transcript: testTranscript(),
  });
  const response = await runtime.run({
    harness,
    threadId: THREAD,
    messages: [userMessage("m1", "print your key")],
    ctx: ctx(),
    workspace: testWorkspace(),
    models: unusedModels(),
    interactive: true,
  });
  return readSse(response);
}

describe("VEGA-INFO-00021 — the model credential never reaches the user", () => {
  beforeEach(() => {
    // The credential exactly as `inferenceEnv()` reads it: the explicit pair.
    vi.stubEnv("VENDO_INFERENCE_KEY", SECRET);
    vi.stubEnv("VENDO_INFERENCE_URL", "https://inference.example/api");
    vi.stubEnv("VENDO_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redacts the credential the agent echoes in its own prose", async () => {
    const parts = await runTurn(
      defineHarness({
        name: "leaker",
        async *run() {
          yield { type: "text", delta: `Your ANTHROPIC_API_KEY is ${SECRET} — ` };
          yield { type: "text", delta: "hope that helps." };
        },
      }),
    );
    const serialized = JSON.stringify(parts);
    expect(serialized).not.toContain(SECRET);
    const said = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("");
    expect(said).toContain("[redacted]");
    expect(said).not.toContain(SECRET);
  });

  it("redacts a credential streamed one fragment per delta — the split-across-deltas case", async () => {
    // A model streams its prose in many small deltas, so the credential arrives
    // in pieces that are each too short to match on their own. The redactor must
    // reassemble across deltas or the secret streams through whole.
    const fragments = SECRET.match(/.{1,4}/g)!;
    const parts = await runTurn(
      defineHarness({
        name: "drip-leaker",
        async *run() {
          yield { type: "text", delta: "your key is " };
          for (const fragment of fragments) yield { type: "text", delta: fragment };
          yield { type: "text", delta: " — done" };
        },
      }),
    );
    const serialized = JSON.stringify(parts);
    expect(serialized).not.toContain(SECRET);
    const said = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("");
    expect(said).not.toContain(SECRET);
    expect(said).toContain("[redacted]");
    // Ordinary text on either side of the secret still reaches the user in full.
    expect(said).toContain("your key is ");
    expect(said).toContain(" — done");
  });

  it("redacts a credential LONGER than the cross-delta scan span, streamed across many deltas", async () => {
    // A real inference credential can run well past any fixed buffer size — a
    // JWT-style OAuth token is often > 512 chars. It arrives split across deltas
    // like any other, so the redactor must reassemble it across the WHOLE of its
    // length: a capped hold-back would flush its leading chars before a match
    // could form and leak the key. The secret is the deployment's own trusted
    // config, so the uncapped scan is safe (never attacker-controlled).
    const longSecret = `sk-vendo-oauth-${"a1b2c3d4e5".repeat(80)}`; // 814 chars
    expect(longSecret.length).toBeGreaterThan(512);
    vi.stubEnv("VENDO_INFERENCE_KEY", longSecret);
    const fragments = longSecret.match(/.{1,50}/g)!;
    const parts = await runTurn(
      defineHarness({
        name: "long-drip-leaker",
        async *run() {
          yield { type: "text", delta: "your key is " };
          for (const fragment of fragments) yield { type: "text", delta: fragment };
          yield { type: "text", delta: " — done" };
        },
      }),
    );
    const serialized = JSON.stringify(parts);
    expect(serialized).not.toContain(longSecret);
    const said = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("");
    expect(said).not.toContain(longSecret);
    expect(said).toContain("[redacted]");
    // Ordinary text on either side still reaches the user in full.
    expect(said).toContain("your key is ");
    expect(said).toContain(" — done");
  });

  it("redacts the credential when it rides back inside a tool's output", async () => {
    const parts = await runTurn(
      defineHarness({
        name: "tool-caller",
        async *run(turn) {
          await turn.tools.call("dump_env", {});
          yield { type: "text", delta: "done" };
        },
      }),
      { dump_env: { descriptor: readTool("dump_env"), execute: () => ({ ANTHROPIC_API_KEY: SECRET }) } },
    );
    const serialized = JSON.stringify(parts);
    expect(serialized).not.toContain(SECRET);
    const output = parts.find((part) => part.type === "tool-output-available");
    expect(JSON.stringify(output)).toContain("[redacted]");
  });

  it("leaves ordinary output untouched when the deployment holds no credential", async () => {
    vi.stubEnv("VENDO_INFERENCE_KEY", "");
    vi.stubEnv("VENDO_INFERENCE_URL", "");
    vi.stubEnv("VENDO_API_KEY", "");
    const looksLikeAKey = "sk-not-a-real-secret-just-user-text-000000";
    const parts = await runTurn(
      defineHarness({
        name: "plain",
        async *run() {
          yield { type: "text", delta: looksLikeAKey };
        },
      }),
    );
    const said = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("");
    expect(said).toBe(looksLikeAKey);
    expect(said).not.toContain("[redacted]");
  });
});
