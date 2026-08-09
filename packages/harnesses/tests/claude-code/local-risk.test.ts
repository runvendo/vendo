/**
 * `machine: "local"` has NO box.
 *
 * The permission hook auto-allows `Bash`/`Write`/`Edit` on the stated grounds
 * that "the box IS the permission — copies only, no credentials, reality happens
 * at commit" (`claude-turn.ts`). On the local path there is no box: the shell is
 * a real shell on the host's own server, and the workspace root is a directory
 * it is pointed at rather than a boundary it is held inside. The mode stays —
 * it is an explicit deployment opt-in — but an operator must not be able to
 * choose it while the code's own rationale tells them the opposite.
 */
import { describe, expect, test, vi } from "vitest";
import { disposeLocalSessions, localMachine } from "../../src/claude-code/local.js";

const noopSession = () => ({
  async send() { /* nothing to think with in this test */ },
  async interrupt() { /* nothing to stop */ },
  async end() { /* nothing to close */ },
});

describe("machine: \"local\" — the honest warning", () => {
  test("the first local machine of the process tells the operator what they granted, ONCE", async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      await localMachine({ threadId: "thr_warn_1", env: {}, openSession: noopSession as never });
      await localMachine({ threadId: "thr_warn_2", env: {}, openSession: noopSession as never });
    } finally {
      spy.mockRestore();
      await disposeLocalSessions();
    }

    const named = warnings.filter((line) => line.includes('machine: "local"'));
    // Once per process: a deployment fact, not a per-turn event.
    expect(named).toHaveLength(1);
    // The specific grant, in the operator's own terms — never a vague caution.
    expect(named[0]).toContain("shell");
    expect(named[0]).toContain("this server");
  });
});
