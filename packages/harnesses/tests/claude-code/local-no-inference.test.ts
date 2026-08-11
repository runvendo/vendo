/**
 * `machine: "local"` with nothing to think with.
 *
 * The SDK spawns with `env` REPLACING the host environment, and since the
 * selection law (#1209) a provider key in that environment is a credential that
 * selects nothing — so `inferenceEnv()` hands the subprocess no model at all for
 * a deployment whose only credential was ANTHROPIC_API_KEY. That is intended.
 * Failing deep inside the SDK with nothing in front of the operator was not:
 * the mode is opt-in, and only the operator can fix it.
 *
 * No `openSession` double here on purpose — the double is exactly what a
 * credential check must not be satisfied by, so this drives the real boot path.
 */
import { describe, expect, test } from "vitest";
import { disposeLocalSessions, localMachine } from "../../src/claude-code/local.js";

const threadId = (): string => `thr_local_noinf_${Math.random().toString(36).slice(2)}`;

describe("machine: \"local\" with no inference credential", () => {
  test("refuses the turn and teaches BOTH ways out, explicit endpoint first", async () => {
    const machine = await localMachine({ threadId: threadId(), env: {} });

    await expect(machine.send({ prompt: "what do I owe?", emit: () => {} }))
      .rejects.toThrow(/has no model to think with/);

    const message = await machine.send({ prompt: "again", emit: () => {} }).catch((error: Error) => error.message);
    // Explicit configuration first, the Cloud key second — the order every boot
    // error in this release teaches.
    expect(message).toContain("VENDO_INFERENCE_URL + VENDO_INFERENCE_KEY");
    expect(message).toContain("VENDO_API_KEY");
    expect((message as string).indexOf("VENDO_INFERENCE_URL"))
      .toBeLessThan((message as string).indexOf("VENDO_API_KEY"));
    // And it says why the key the operator DOES have is not being used, instead
    // of advising them to set one they already set.
    expect(message).toContain("A provider key alone no longer selects a model");
    expect(message).toContain("REPLACED rather than inherited");

    await disposeLocalSessions();
  });

  test("a resolved credential opens the session — the gate reads the env, not the mode", async () => {
    // inferenceEnv() writes ANTHROPIC_API_KEY once it has resolved a rung; that
    // resolved value is what the check accepts, so the ONLY thing separating this
    // from the case above is a credential.
    const opened: Array<Record<string, unknown>> = [];
    const machine = await localMachine({
      threadId: threadId(),
      env: { ANTHROPIC_API_KEY: "resolved-by-inferenceEnv" },
      openSession: ((input: Record<string, unknown>) => {
        opened.push(input);
        return { async send() {}, steer: () => false, async interrupt() {}, async end() {} };
      }) as never,
    });

    await machine.send({ prompt: "what do I owe?", emit: () => {} });
    expect(opened).toHaveLength(1);

    await disposeLocalSessions();
  });
});
