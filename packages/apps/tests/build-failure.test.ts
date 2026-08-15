import {
  type RunContext,
  type ToolRegistry,
  VendoError,
} from "@vendoai/core";
import type {
  ScreenAssembler,
} from "../src/contract/index.js";
import { describe, expect, it, vi } from "vitest";
import { buildFailureReason } from "../src/server/doors/build-messages.js";
import { createApps, type AppsRuntime } from "../src/server/index.js";
import { scriptedAssembler } from "../src/server/testing/screen-assembler.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { basicLanguageModel } from "../src/server/testing/scripted-model.js";

// Incident (runvendo/vendo#492): the pack's vendo_make returns fast with a
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

/**
 * The build is the ONE engine — the assembler in the `screen` slot — so every
 * failure class below arrives from THERE now: a throw, an `unavailable`, or an
 * assemble that never settles. The brain that used to own these is gone.
 */
const throwingAssembler = (message: string): ScreenAssembler => ({
  assemble: async () => { throw new Error(message); },
});

/** A throw carrying the engine's own issue lines, the way a failed generation
 *  inside the assembler reports itself. */
const failingAssembler = (issues: string[]): ScreenAssembler => ({
  assemble: async () => { throw new VendoError("validation", issues[0]!, issues); },
});

const setup = (screen: ScreenAssembler) => {
  const store = memoryStore();
  const runtime = createApps({
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    model: basicLanguageModel(),
    screen,
  });
  return { store, runtime };
};

describe("build-failure lifecycle (#492)", () => {
  it("persists a terminal failed record when the build turn throws, and open() resolves to {kind:\"failed\"}", async () => {
    const { runtime, store } = setup(throwingAssembler("boom"));
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
    expect(surface).toEqual({ kind: "failed", reason: "generation failed", retryable: true, prompt: "A weather board" });
  });

  it("persists a failed record for every throwing build, so open() never leaves the embed pending", async () => {
    // The `ai` SDK wraps the provider message before it reaches the engine's
    // swallowed issues, so the precise quota/timeout CLASS is asserted by the
    // buildFailureReason unit tests below; here we assert the record is always
    // persisted as a terminal failure open() resolves promptly.
    const { runtime, store } = setup(throwingAssembler("insufficient quota (402)"));
    const ctx = context("user_grace");
    await expect(runtime.create({ prompt: "Dashboard" }, ctx)).rejects.toBeInstanceOf(VendoError);
    const rows = await store.records("vendo_apps").list({});
    const surface = await runtime.open(rows.records[0]!.id, ctx);
    expect(surface).toMatchObject({ kind: "failed" });
    expect((surface as { reason: string }).reason).toMatch(/\S/);
  });

  it("still throws not-found (→ the wire's {kind:\"pending\"}) for an app that never persisted", async () => {
    const { runtime } = setup(throwingAssembler("boom"));
    await expect(runtime.open("app_never", context("user_ada"))).rejects.toMatchObject({ code: "not-found" });
  });

  it("re-throws CARRYING the classified reason (tool outcome + wire read it from the message), and logs the failure server-side", async () => {
    // Wave 2 (0.4.x E2E): the calling agent saw only {code:"validation",
    // message:"model could not produce a valid app"} and the server log was
    // silent — the reason must ride the thrown error and the operator log.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { runtime } = setup(throwingAssembler("boom"));
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
      // The model call now lives inside the assembler, so this door's job is to
      // carry the engine's own line out UNREWRITTEN: a build failure's `issues`
      // are what the engine reported, never a compile artifact invented here.
      const { runtime } = setup(failingAssembler([
        "the model answered with no text at all (an empty or reasoning-only response from the provider).",
      ]));
      const rejection = await runtime.create({ prompt: "Track invoice statuses" }, context("user_ada"))
        .then(() => undefined, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(VendoError);
      const issues = ((rejection as VendoError).detail as { issues: string[] }).issues;
      expect(issues.some((issue) => issue.includes("no text at all"))).toBe(true);
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
      const { runtime, store } = setup(throwingAssembler(line));
      const ctx = context("user_ada");
      const rejection = await runtime.create({ prompt: "Dashboard" }, ctx)
        .then(() => undefined, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(VendoError);
      expect((rejection as VendoError).message).toBe(`app build failed: ${line}`);
      const rows = await store.records("vendo_apps").list({});
      const surface = await runtime.open(rows.records[0]!.id, ctx);
      expect(surface).toEqual({ kind: "failed", reason: line, retryable: false, prompt: "Dashboard" });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// 0.4.5 E2E cert (defect D, byo-ai-sdk host): an ask this host cannot serve
// must fail LOUDLY rather than "succeed" into an app that says nothing — no
// failure record, no log, and a host chat that reads as a build hanging
// forever. And a build task that never SETTLES (hung provider stream, promise
// chain severed by the host runtime) persisted nothing at all, so the embed
// polled {kind:"pending"} past every deadline.
describe("defect D — silent degenerate/hung builds fail loudly", () => {
  it("fails a refused build terminally: record persisted, open() answers the refusal, create() throws it", async () => {
    // The engine's own sentence IS the reason: an impossible ask comes back as an
    // `unavailable` whose `why` is what the person reads, verbatim — a generic
    // apology is nothing anyone can act on.
    const reason = "Your host has no way to read account balances, so nothing here can show one.";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { runtime, store } = setup({ assemble: async () => ({ kind: "unavailable", why: reason }) });
      const ctx = context("user_ada");
      const rejection = await runtime.create({ prompt: "one stat tile that says hello" }, ctx)
        .then(() => undefined, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(VendoError);
      expect((rejection as VendoError).message).toBe(`app build failed: ${reason}`);
      const rows = await store.records("vendo_apps").list({});
      expect(rows.records).toHaveLength(1);
      const surface = await runtime.open(rows.records[0]!.id, ctx);
      // Retryable: assembly coming back empty is not a claim that the ask is
      // impossible forever — only a throw the classifier recognises (quota, a
      // dead key) is non-retryable.
      expect(surface).toEqual({ kind: "failed", reason, retryable: true, prompt: "one stat tile that says hello" });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("app build failed"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("the watchdog persists a terminal failed record for a build that neither completes nor throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env["VENDO_APP_BUILD_WATCHDOG_MS"] = "60";
    try {
      // An assemble that never settles: the build turn hangs forever, the
      // create catch never runs, and without the watchdog nothing would ever
      // be persisted for the minted app id.
      const { runtime, store } = setup({ assemble: () => new Promise<never>(() => undefined) });
      void runtime.create({ prompt: "Dashboard" }, context("user_ada")).catch(() => undefined);
      await vi.waitFor(async () => {
        const rows = await store.records("vendo_apps").list({});
        expect(rows.records).toHaveLength(1);
        expect(rows.records[0]?.data).toMatchObject({
          subject: "user_ada",
          // speed-core criterion 8 — the record carries the exact prompt so
          // the embed's retry affordance can re-issue the create.
          doc: { buildFailed: { retryable: true, prompt: "Dashboard" } },
        });
      }, { timeout: 3_000 });
      const rows = await store.records("vendo_apps").list({});
      const surface = await runtime.open(rows.records[0]!.id, context("user_ada"));
      expect(surface).toMatchObject({ kind: "failed", retryable: true, prompt: "Dashboard" });
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
      let runtime!: AppsRuntime;
      const composed = setup(scriptedAssembler(() => runtime, async () => {
        await gate;
        return `import { Stack, Text } from "@vendo/screen";

export default function LateBoard() {
  return <Stack gap={12}><Text text="Late board" variant="heading" /></Stack>;
}
`;
      }));
      runtime = composed.runtime;
      const store = composed.store;
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

describe("buildFailureReason", () => {
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
    // THE COUPLING, from the consumer's side. This is NO_CREDENTIAL_MESSAGE in
    // @vendoai/vendo (dev-creds/model.ts), which this package may not import, so
    // the literal is pinned from both sides: here against the real
    // MODEL_UNAVAILABLE_SIGNAL, and there against the real constant
    // (tests/dev-creds/model.test.ts, "keeps the exact bytes @vendoai/apps'
    // MODEL_UNAVAILABLE_SIGNAL anchors on"). Reword the message and that one
    // fails; retune the pattern and this one does. Neither can drift quietly —
    // which the old wording did, and the actionable line then reaches only the
    // operator's terminal (0.4.x, measured twice).
    const noKeyLine = "Vendo has no model. Pass one — models: { default: anthropic(\"claude-sonnet-4-6\") } in "
      + "createVendo — or set VENDO_API_KEY for the Vendo Cloud gateway (`vendo login` mints a free "
      + "dev key). A provider key alone no longer selects a model; Vendo never picks a provider for you.";
    expect(buildFailureReason(new Error(noKeyLine))).toEqual({ reason: noKeyLine, retryable: false });
  });

  it("passes the ladder's REJECTED-key lines through too — a 401 is the same actionable class", () => {
    // Both shapes are crafted by vendo/dev-creds (rejectedKey), not by a
    // provider: the whole point is that only the ladder knows which credential
    // was refused, so collapsing them to "generation failed · retry" sends the
    // person back to the same dead key with nothing to act on.
    const envLine = "your Anthropic API key was rejected (401) — check ANTHROPIC_API_KEY in .env.local; "
      + "a revoked or mistyped key fails exactly this way.";
    expect(buildFailureReason(new VendoError("validation", "model could not produce a valid app", [
      `model generation failed: ${envLine}`,
    ]))).toEqual({ reason: envLine, retryable: false });
    const cloudLine = "VENDO_API_KEY was rejected by the Vendo Cloud model gateway (401) — run `vendo login` to mint "
      + "a fresh key (it lands in .env.local), or manage project keys in the Vendo Cloud console.";
    expect(buildFailureReason(new Error(cloudLine))).toEqual({ reason: cloudLine, retryable: false });
  });

  it("never mistakes a provider key error for the dev-model class (no raw-message leak)", () => {
    // A provider message that mentions a key must stay canned — raw provider
    // text (which can echo key prefixes) never reaches the surface.
    expect(buildFailureReason(new Error("Incorrect API key provided: sk-proj-123")))
      .toEqual({ reason: "generation failed", retryable: true });
  });
});

// A quota exhaustion is a BILLING claim about the host's account and it is
// non-retryable, so a false one tells the person two lies at once. The
// classifier used to scan a blob of every candidate string joined together —
// including the honesty gate's findings, which quote the whole host tool
// inventory (checking/facts.ts `the host tools are: …`). demo-bank's inventory
// contains `host_listScheduledPayments`, the pattern contained the bare word
// "payment", so ordinary generation failures shipped as "quota exhausted ·
// retryable: false" (observed live 2026-08-03, wave E2E). Both halves are
// pinned here: the SOURCE is the provider's own error lines only, and the
// PATTERN needs provider quota language rather than a word that lives in tool
// and field names.
describe("buildFailureReason quota classification (fix-quota-lie)", () => {
  /** The engine's `model generation failed: ` prefix is the ONLY marker of a
   *  provider line inside the terminal validation throw's issues, so it is what
   *  the classifier keys on (generation/engine.ts askModel). */
  const providerFailure = (message: string) =>
    new VendoError("validation", `model generation failed: ${message}`, [`model generation failed: ${message}`]);

  /** A terminal validation throw: the issues are the gate's own findings, with
   *  no provider line anywhere. */
  const validationFailure = (...issues: string[]) =>
    new VendoError("validation", issues[0]!, issues);

  const hostToolInventory = "host_getAccounts, host_getAccountBalance, host_listTransactions, "
    + "host_listScheduledPayments, host_schedulePayment, host_listInvoices";

  it("a real provider quota error → quota exhausted, non-retryable", () => {
    expect(buildFailureReason(providerFailure(
      "You exceeded your current quota, please check your plan and billing details.",
    ))).toEqual({ reason: "quota exhausted", retryable: false });
    // OpenAI's machine code: the underscore means there is no word boundary
    // before "quota", so the pattern must name this shape itself.
    expect(buildFailureReason(providerFailure("429 insufficient_quota")))
      .toEqual({ reason: "quota exhausted", retryable: false });
  });

  it("a real 402 → quota exhausted, non-retryable", () => {
    expect(buildFailureReason(providerFailure("Provider returned 402 Payment Required")))
      .toEqual({ reason: "quota exhausted", retryable: false });
  });

  it("a validation failure whose findings quote the host tool inventory → generation failed, RETRYABLE", () => {
    // The live defect, verbatim in shape: `host_listScheduledPayments` inside
    // the finding's inventory used to be read as the provider saying the
    // account is out of credit.
    expect(buildFailureReason(validationFailure(
      `query "scheduledOut" names unknown tool "spending.data.reduce"; the host tools are: ${hostToolInventory}`,
    ))).toEqual({ reason: "generation failed", retryable: true });
    // The same class through the app's own content: a payments view, a billing
    // identifier, a "payment" label. None of it is a provider signal.
    expect(buildFailureReason(validationFailure(
      'binding "$payments.billing_id" does not resolve; the fields are: billing_id, payment_status, amount',
      "the Payment History table has no rows and no empty state",
    ))).toEqual({ reason: "generation failed", retryable: true });
  });

  it("a provider timeout → timed out, retryable", () => {
    expect(buildFailureReason(providerFailure("Request timed out after 60000ms")))
      .toEqual({ reason: "timed out", retryable: true });
  });

  it("a plain unknown failure → generation failed, retryable", () => {
    expect(buildFailureReason(new Error("boom")))
      .toEqual({ reason: "generation failed", retryable: true });
    expect(buildFailureReason(validationFailure("the model answered with no text at all")))
      .toEqual({ reason: "generation failed", retryable: true });
  });
});
