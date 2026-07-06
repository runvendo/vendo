import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "./init.js";
import type { Interactor } from "./interact.js";
import { textModel } from "./test-helpers.js";

/** Parses the properties of the init_completed capture from the fetch spy. */
function completedProps(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
  for (const call of fetchImpl.mock.calls) {
    const body = JSON.parse((call[1] as { body: string }).body);
    if (body.event === "init_completed") return body.properties ?? {};
  }
  throw new Error("no init_completed event captured");
}

/** A fake masked-input seam replaying `inputs`; counts invocations. */
function fakeInteractor(inputs: Array<string | null>): { interactor: Interactor; count: () => number } {
  let i = 0;
  let calls = 0;
  return {
    count: () => calls,
    interactor: {
      async maskedInput() {
        calls++;
        return inputs[Math.min(i++, inputs.length - 1)] ?? null;
      },
      async multiSelect() {
        return null;
      },
    },
  };
}

const PROVIDER_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "VENDO_MODEL",
  "VENDO_CLI_MODEL",
];

describe("init telemetry", () => {
  let savedEnv: Record<string, string | undefined>;
  beforeEach(() => {
    savedEnv = {};
    for (const k of PROVIDER_VARS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of PROVIDER_VARS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("emits init_started and init_completed with counts", async () => {
    const home = mkdtempSync(join(tmpdir(), "vendo-init-tele-"));
    const target = mkdtempSync(join(tmpdir(), "vendo-init-target-"));
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    try {
      await runInit({
        targetDir: target,
        skipLlm: true,
        force: true,
        model: null,
        telemetry: { home, posthogKey: "phc_test", env: { NODE_ENV: "test" }, fetchImpl },
      });
      const events = fetchImpl.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body).event);
      expect(events).toContain("init_started");
      expect(events).toContain("init_completed");
      // --skip-llm never shows the prompt.
      expect(completedProps(fetchImpl).keyPrompt).toBe("not-shown");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("records keyPrompt=provided when a pasted key is saved (never the key itself)", async () => {
    const home = mkdtempSync(join(tmpdir(), "vendo-init-tele-"));
    const target = mkdtempSync(join(tmpdir(), "vendo-init-target-"));
    writeFileSync(join(target, "package.json"), "{}");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const secret = "sk-ant-tele-secret";
    const { interactor } = fakeInteractor([secret]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runInit({
        targetDir: target,
        skipLlm: false,
        force: false,
        interactive: true,
        interactor,
        keyValidateDeps: { model: textModel(["ok"]) },
        telemetry: { home, posthogKey: "phc_test", env: { NODE_ENV: "test" }, fetchImpl },
      });
      expect(completedProps(fetchImpl).keyPrompt).toBe("provided");
      // The raw key must never appear in any telemetry body.
      const allBodies = fetchImpl.mock.calls.map((c) => (c[1] as { body: string }).body).join("\n");
      expect(allBodies).not.toContain(secret);
    } finally {
      log.mockRestore();
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("records keyPrompt=invalid when a rejected key is followed by an Enter-skip", async () => {
    const home = mkdtempSync(join(tmpdir(), "vendo-init-tele-"));
    const target = mkdtempSync(join(tmpdir(), "vendo-init-target-"));
    writeFileSync(join(target, "package.json"), "{}");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    // An unrecognized key shape counts as a rejection (no network needed);
    // Enter then ends the loop in skip → the recorded outcome is "invalid".
    const { interactor } = fakeInteractor(["not-a-real-key", ""]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runInit({
        targetDir: target,
        skipLlm: false,
        force: false,
        interactive: true,
        interactor,
        telemetry: { home, posthogKey: "phc_test", env: { NODE_ENV: "test" }, fetchImpl },
      });
      expect(completedProps(fetchImpl).keyPrompt).toBe("invalid");
    } finally {
      log.mockRestore();
      err.mockRestore();
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("records keyPrompt=skipped when the prompt is Enter-skipped", async () => {
    const home = mkdtempSync(join(tmpdir(), "vendo-init-tele-"));
    const target = mkdtempSync(join(tmpdir(), "vendo-init-target-"));
    writeFileSync(join(target, "package.json"), "{}");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const { interactor } = fakeInteractor([""]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runInit({
        targetDir: target,
        skipLlm: false,
        force: false,
        interactive: true,
        interactor,
        telemetry: { home, posthogKey: "phc_test", env: { NODE_ENV: "test" }, fetchImpl },
      });
      expect(completedProps(fetchImpl).keyPrompt).toBe("skipped");
    } finally {
      log.mockRestore();
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});
