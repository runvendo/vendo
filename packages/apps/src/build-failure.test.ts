import type { LanguageModel } from "ai";
import type { RunContext, ToolRegistry } from "@vendoai/core";
import { VendoError } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { buildFailureReason, createApps } from "./index.js";
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
});
