import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  it("emits command=init and zeroed component-picker counts on a deterministic run", async () => {
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
      const props = completedProps(fetchImpl);
      expect(props.command).toBe("init");
      // No model means the component picker did not run.
      expect(props.componentsOffered).toBe(0);
      expect(props.componentCount).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("tags a refresh-mode run with command=refresh", async () => {
    const home = mkdtempSync(join(tmpdir(), "vendo-init-tele-"));
    const target = mkdtempSync(join(tmpdir(), "vendo-init-target-"));
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    try {
      await runInit({
        targetDir: target,
        skipLlm: true,
        force: true,
        model: null,
        mode: "refresh",
        telemetry: { home, posthogKey: "phc_test", env: { NODE_ENV: "test" }, fetchImpl },
      });
      expect(completedProps(fetchImpl).command).toBe("refresh");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("componentsOffered reflects the FILTERED picker count on a re-run (already-wrapped not counted)", async () => {
    const home = mkdtempSync(join(tmpdir(), "vendo-init-tele-"));
    const target = mkdtempSync(join(tmpdir(), "vendo-init-comp-"));
    // Two ui/ primitives (badge, panel); no app/api routes so the ONLY model
    // calls are the catalog propose/analyze.
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: "host", dependencies: { next: "15.0.0" } }));
    for (const [rel, body] of Object.entries({
      "src/app/globals.css": ":root { --color-bg: #fff; }",
      "src/components/ui/badge.tsx": "export const Badge = () => null",
      "src/components/ui/panel.tsx": "export const Panel = () => null",
      // A pre-existing wrapper for Badge → discovered-but-already-wrapped, so it
      // is filtered out BEFORE the picker and must not count as offered.
      ".vendo/components/Badge/descriptor.ts": "export const d = {};\n",
      ".vendo/components/Badge/impl.tsx": "export const C = () => null;\n",
    })) {
      mkdirSync(dirname(join(target, rel)), { recursive: true });
      writeFileSync(join(target, rel), body);
    }
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    // Only panel is proposed (badge is filtered before propose); pick it.
    const proposePanel = JSON.stringify({ proposals: [{ file: "src/components/ui/panel.tsx", wrappable: true, reason: "Container." }] });
    const panelInclude = JSON.stringify({
      include: true, reason: "primitive", name: "Panel", description: "A container.",
      imports: ["Panel"], props: [{ name: "text", type: "string", optional: false, description: "Body." }],
      jsx: "<Panel>{p.text}</Panel>",
    });
    const interactor: Interactor = {
      async maskedInput() {
        return null;
      },
      async multiSelect() {
        return ["src/components/ui/panel.tsx"] as never;
      },
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runInit({
        targetDir: target,
        skipLlm: false,
        force: false,
        interactive: true,
        interactor,
        model: textModel([proposePanel, panelInclude]),
        telemetry: { home, posthogKey: "phc_test", env: { NODE_ENV: "test" }, fetchImpl },
      });
      const props = completedProps(fetchImpl);
      // Two components discovered, but Badge was already wrapped → offered = 1.
      expect(props.componentsOffered).toBe(1);
      expect(props.componentCount).toBe(1); // only Panel written
    } finally {
      log.mockRestore();
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

});
