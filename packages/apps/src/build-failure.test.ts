import type { LanguageModel } from "ai";
import type { RunContext, ToolRegistry, TreeV2 } from "@vendoai/core";
import { VendoError } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { buildFailureReason, createApps } from "./index.js";
import { DISCLAIMER_TEXT, isDisclaimerOnlyTree } from "./pipeline.js";
import { HOST_CAPABILITY_MISS_REASON } from "./runtime.js";
import { guardFixture, memoryStore, scriptedLanguageModel } from "./testing/index.js";

// Incident (runvendo/vendo#492): vendo_create_app returns fast with a
// vendo/app-ref@1 while the build streams server-side. When the build turn
// THROWS (model error / quota / timeout) the app record never landed, so
// open() kept answering not-found → the embed spun to APP_BUILD_DEADLINE_MS
// before the generic failed beat. The fix persists a TERMINAL failed record so
// open() resolves the embed promptly with the reason.

const tools: ToolRegistry = {
  async descriptors() {
    return [];
  },
  async execute() {
    return { status: "error", error: { code: "not-found", message: "No fixture tools" } };
  },
};

const context = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `session_${subject}`,
});

/** A model whose every turn throws — the provider-error build path. */
const throwingModel = (message: string): LanguageModel =>
  scriptedLanguageModel(() => {
    throw new Error(message);
  });

const setup = (model: LanguageModel) => {
  const store = memoryStore();
  const runtime = createApps({ store, guard: guardFixture(), tools, catalog: [], model });
  return { store, runtime };
};

describe("build-failure lifecycle (#492)", () => {
  it("persists a terminal failed record when the build turn throws, and open() resolves to {kind:\"failed\"}", async () => {
    const { runtime, store } = setup(throwingModel("boom"));
    const ctx = context("user_ada");

    let appId: string | undefined;
    // create() still rejects (the tool contract is unchanged), but now it
    // leaves a persisted failed record behind.
    await expect(
      (async () => {
        try {
          await runtime.create({ prompt: "A weather board" }, ctx);
        } catch (error) {
          // Recover the minted app id from the persisted record.
          const rows = await store.records("vendo_apps").list({});
          appId = rows.records[0]?.id;
          throw error;
        }
      })(),
    ).rejects.toBeInstanceOf(VendoError);

    expect(appId).toBeDefined();
    const record = await store.records("vendo_apps").get(appId!);
    expect(record?.data).toMatchObject({
      subject: "user_ada",
      enabled: false,
      doc: { buildFailed: { reason: "generation failed", retryable: true } },
    });

    const surface = await runtime.open(appId!, ctx);
    expect(surface).toEqual({ kind: "failed", reason: "generation failed", retryable: true });
  });

  it("persists a failed record for every throwing build, so open() never leaves the embed pending", async () => {
    // The `ai` SDK wraps the provider message before it reaches the engine's
    // swallowed issues, so the precise quota/timeout CLASS is asserted by the
    // buildFailureReason unit tests below; here we assert the record is always
    // persisted as a terminal failure open() resolves promptly.
    const { runtime, store } = setup(throwingModel("insufficient quota (402)"));
    const ctx = context("user_grace");
    await expect(runtime.create({ prompt: "Dashboard" }, ctx)).rejects.toBeInstanceOf(VendoError);
    const rows = await store.records("vendo_apps").list({});
    const surface = await runtime.open(rows.records[0]!.id, ctx);
    expect(surface).toMatchObject({ kind: "failed" });
    expect((surface as { reason: string }).reason).toMatch(/\S/);
  });

  it("still throws not-found (→ the wire's {kind:\"pending\"}) for an app that never persisted", async () => {
    const { runtime } = setup(throwingModel("boom"));
    await expect(runtime.open("app_never", context("user_ada"))).rejects.toMatchObject({ code: "not-found" });
  });

  it("re-throws CARRYING the classified reason (tool outcome + wire read it from the message), and logs the failure server-side", async () => {
    // Wave 2 (0.4.x E2E): the calling agent saw only {code:"validation",
    // message:"model could not produce a valid app"} and the server log was
    // silent — the reason must ride the thrown error and the operator log.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { runtime } = setup(throwingModel("boom"));
      const rejection = await runtime.create({ prompt: "Dashboard" }, context("user_ada"))
        .then(() => undefined, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(VendoError);
      const thrown = rejection as VendoError;
      expect(thrown.message).toBe("app build failed: generation failed");
      expect(thrown.detail).toMatchObject({ reason: "generation failed", retryable: true });
      expect((thrown.detail as { appId: string }).appId).toMatch(/^app_/);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("app build failed"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("names an empty model stream as the failure instead of the empty string's wire-parse issues (0.4.4 defect A)", async () => {
    // 0.4.4 E2E cert: a gateway alias with forced extended thinking sometimes
    // ends the turn reasoning-only — the stream completes cleanly with ZERO
    // text. Compiling "" reported "wire missing-app… / empty layout", which
    // reads as a model-format defect and mis-routed the triage. The stream
    // helper now names the real failure class.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { runtime } = setup(scriptedLanguageModel(""));
      const rejection = await runtime.create({ prompt: "Track invoice statuses" }, context("user_ada"))
        .then(() => undefined, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(VendoError);
      const issues = ((rejection as VendoError).detail as { issues: string[] }).issues;
      expect(issues.some((issue) => issue.includes("completed without any text output"))).toBe(true);
      expect(issues.some((issue) => issue.includes("missing-app"))).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("surfaces the dev-model's actionable no-key line in the failed record, open(), and the thrown error", async () => {
    // 0.4.x E2E defect: with a provider key set but the @ai-sdk package
    // missing, the surface said {"code":"validation","model could not produce
    // a valid app"} while the actionable install line was terminal-only.
    const line = "OPENAI_API_KEY is set but @ai-sdk/openai is not installed in this app; install it (`npm install ai@^6 @ai-sdk/openai@^3`).";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { runtime, store } = setup(throwingModel(line));
      const ctx = context("user_ada");
      const rejection = await runtime.create({ prompt: "Dashboard" }, ctx)
        .then(() => undefined, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(VendoError);
      expect((rejection as VendoError).message).toBe(`app build failed: ${line}`);
      const rows = await store.records("vendo_apps").list({});
      const surface = await runtime.open(rows.records[0]!.id, ctx);
      expect(surface).toEqual({ kind: "failed", reason: line, retryable: false });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// 0.4.5 E2E cert (defect D, byo-ai-sdk host): a create whose every region was
// disclaimed away by repair "succeeded" into an app that only said "not
// available" — no failure record, no log, and a host chat that read as a
// build hanging forever. And a build task that never SETTLES (hung provider
// stream, promise chain severed by the host runtime) persisted nothing at
// all, so the embed polled {kind:"pending"} past every deadline.
describe("defect D — silent degenerate/hung builds fail loudly", () => {
  const disclaimerMarkup =
    `<App name="Hello stat"><Surface><Text text="${DISCLAIMER_TEXT}"/></Surface></App>`;

  it("fails a disclaimer-only build terminally: record persisted, open() answers the host-capability reason, create() throws it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { runtime, store } = setup(scriptedLanguageModel(disclaimerMarkup));
      const ctx = context("user_ada");
      const rejection = await runtime.create({ prompt: "one stat tile that says hello" }, ctx)
        .then(() => undefined, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(VendoError);
      expect((rejection as VendoError).message).toBe(`app build failed: ${HOST_CAPABILITY_MISS_REASON}`);
      const rows = await store.records("vendo_apps").list({});
      expect(rows.records).toHaveLength(1);
      const surface = await runtime.open(rows.records[0]!.id, ctx);
      expect(surface).toEqual({ kind: "failed", reason: HOST_CAPABILITY_MISS_REASON, retryable: false });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("app build failed"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("the watchdog persists a terminal failed record for a build that neither completes nor throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env["VENDO_APP_BUILD_WATCHDOG_MS"] = "60";
    try {
      // A model stream that never settles: the build turn hangs forever, the
      // create catch never runs, and without the watchdog nothing would ever
      // be persisted for the minted app id.
      const { runtime, store } = setup(scriptedLanguageModel(() => new Promise<never>(() => undefined)));
      void runtime.create({ prompt: "Dashboard" }, context("user_ada")).catch(() => undefined);
      await vi.waitFor(async () => {
        const rows = await store.records("vendo_apps").list({});
        expect(rows.records).toHaveLength(1);
        expect(rows.records[0]?.data).toMatchObject({
          subject: "user_ada",
          doc: { buildFailed: { retryable: true } },
        });
      }, { timeout: 3_000 });
      const rows = await store.records("vendo_apps").list({});
      const surface = await runtime.open(rows.records[0]!.id, context("user_ada"));
      expect(surface).toMatchObject({ kind: "failed", retryable: true });
      expect((surface as { reason: string }).reason).toContain("never finished");
    } finally {
      delete process.env["VENDO_APP_BUILD_WATCHDOG_MS"];
      errorSpy.mockRestore();
    }
  });

  it("a late success after the watchdog fired overwrites the failed record (self-healing, never the reverse)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env["VENDO_APP_BUILD_WATCHDOG_MS"] = "40";
    try {
      let releaseBuild!: () => void;
      const gate = new Promise<void>((resolve) => { releaseBuild = resolve; });
      const { runtime, store } = setup(scriptedLanguageModel(async () => {
        await gate;
        return `<App name="Late board"><Text text="Late board"/></App>`;
      }));
      const ctx = context("user_ada");
      const pendingCreate = runtime.create({ prompt: "Late board" }, ctx);
      // Watchdog fires first: the terminal failed record lands.
      await vi.waitFor(async () => {
        const rows = await store.records("vendo_apps").list({});
        expect(rows.records[0]?.data).toMatchObject({ doc: { buildFailed: { retryable: true } } });
      }, { timeout: 3_000 });
      // The hung build then completes after all: the real document replaces it.
      releaseBuild();
      const app = await pendingCreate;
      const surface = await runtime.open(app.id, ctx);
      expect(surface).toMatchObject({ kind: "tree" });
    } finally {
      delete process.env["VENDO_APP_BUILD_WATCHDOG_MS"];
      errorSpy.mockRestore();
    }
  });
});

describe("isDisclaimerOnlyTree", () => {
  const tree = (nodes: TreeV2["nodes"]): TreeV2 => ({
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired", children: nodes.map((node) => node.id) }, ...nodes],
  } as TreeV2);
  const disclaimer = (id: string): TreeV2["nodes"][number] =>
    ({ id, component: "Text", source: "prewired", props: { text: DISCLAIMER_TEXT } }) as TreeV2["nodes"][number];

  it("flags the pure disclaimer tree (the cert's persisted shape)", () => {
    expect(isDisclaimerOnlyTree(tree([disclaimer("text-1")]))).toBe(true);
  });

  it("static copy around the disclaimers does not rescue it (the cloud-rung cert shape: heading + disclaimer)", () => {
    expect(isDisclaimerOnlyTree(tree([
      { id: "heading-1", component: "Text", source: "prewired", props: { text: "Dashboard", variant: "heading" } } as TreeV2["nodes"][number],
      disclaimer("text-1"),
    ]))).toBe(true);
  });

  it("a data binding beside a disclaimer is real content — not degenerate", () => {
    expect(isDisclaimerOnlyTree(tree([
      disclaimer("text-1"),
      { id: "stat-1", component: "Stat", source: "prewired", props: { label: "Total", value: { $path: "/totals/sum" } } } as TreeV2["nodes"][number],
    ]))).toBe(false);
  });

  it("an action binding beside a disclaimer is real content — not degenerate", () => {
    expect(isDisclaimerOnlyTree(tree([
      disclaimer("text-1"),
      { id: "button-1", component: "Button", source: "prewired", props: { label: "Refresh", onClick: { action: "host_refresh" } } } as TreeV2["nodes"][number],
    ]))).toBe(false);
  });

  it("a generated island or host component beside a disclaimer is real content — not degenerate", () => {
    expect(isDisclaimerOnlyTree(tree([
      disclaimer("text-1"),
      { id: "appshell-1", component: "AppShell", source: "generated" } as TreeV2["nodes"][number],
    ]))).toBe(false);
    expect(isDisclaimerOnlyTree(tree([
      disclaimer("text-1"),
      { id: "chart-1", component: "RevenueChart", source: "host" } as TreeV2["nodes"][number],
    ]))).toBe(false);
  });

  it("a tree with no disclaimers is never degenerate, whatever else it lacks", () => {
    expect(isDisclaimerOnlyTree(tree([
      { id: "text-1", component: "Text", source: "prewired", props: { text: "hello" } } as TreeV2["nodes"][number],
    ]))).toBe(false);
  });

  it("ignores unreachable disclaimer nodes (pruned subtrees)", () => {
    const detached: TreeV2 = {
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "prewired", children: ["text-1"] },
        { id: "text-1", component: "Text", source: "prewired", props: { text: "hello" } },
        { id: "orphan-1", component: "Text", source: "prewired", props: { text: DISCLAIMER_TEXT } },
      ],
    } as TreeV2;
    expect(isDisclaimerOnlyTree(detached)).toBe(false);
  });
});

describe("buildFailureReason", () => {
  it("passes the host-capability miss reason through verbatim, non-retryable (defect D)", () => {
    expect(buildFailureReason(new VendoError("validation", HOST_CAPABILITY_MISS_REASON)))
      .toEqual({ reason: HOST_CAPABILITY_MISS_REASON, retryable: false });
  });

  it("maps an aborted turn to a retryable timeout", () => {
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(buildFailureReason(aborted)).toEqual({ reason: "timed out", retryable: true });
  });

  it("maps a 402 (statusCode or cloud-required) to a non-retryable quota exhaustion", () => {
    expect(buildFailureReason(Object.assign(new Error("payment required"), { statusCode: 402 })))
      .toEqual({ reason: "quota exhausted", retryable: false });
    expect(buildFailureReason(new VendoError("cloud-required", "VENDO_API_KEY required")))
      .toEqual({ reason: "quota exhausted", retryable: false });
  });

  it("classifies the terminal validation throw from its swallowed issues", () => {
    expect(buildFailureReason(new VendoError("validation", "model could not produce a valid app", [
      "model generation failed: insufficient quota",
    ]))).toEqual({ reason: "quota exhausted", retryable: false });
    expect(buildFailureReason(new VendoError("validation", "model could not produce a valid app", [
      "model generation failed: the request timed out",
    ]))).toEqual({ reason: "timed out", retryable: true });
    expect(buildFailureReason(new VendoError("validation", "model could not produce a valid app", [
      "model generation failed: unparseable output",
    ]))).toEqual({ reason: "generation failed", retryable: true });
  });

  it("passes the dev-model's own unavailable-credential lines through verbatim (they ARE the fix)", () => {
    const installLine = "ANTHROPIC_API_KEY is set but @ai-sdk/anthropic is not installed in this app; install it (`npm install ai@^6 @ai-sdk/anthropic@^3`).";
    expect(buildFailureReason(new VendoError("validation", "model could not produce a valid app", [
      `model generation failed: ${installLine}`,
    ]))).toEqual({ reason: installLine, retryable: false });
    const noKeyLine = "Vendo found no model key. Set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY "
      + "in .env.local (with the matching @ai-sdk provider installed), or run `vendo login` for a "
      + "free dev key. Production always needs a real server-side key.";
    expect(buildFailureReason(new Error(noKeyLine))).toEqual({ reason: noKeyLine, retryable: false });
  });

  it("never mistakes a provider key error for the dev-model class (no raw-message leak)", () => {
    // A provider message that mentions a key must stay canned — raw provider
    // text (which can echo key prefixes) never reaches the surface.
    expect(buildFailureReason(new Error("Incorrect API key provided: sk-proj-123")))
      .toEqual({ reason: "generation failed", retryable: true });
  });
});
