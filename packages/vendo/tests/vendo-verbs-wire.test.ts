/**
 * Design §4's vendo verbs, on the ONE registry, through the real composition.
 *
 * Lane D built `vendoVerbsRegistry` and could not compose it — the ports needed
 * apps/automations internals. These tests read the verbs the way a harness does:
 * off the guard-bound registry a real `createVendo` produced.
 *
 * The names matter as much as the behaviour: the building-apps skill teaches
 * `validate` BY NAME, and a skill body is copied to a harness verbatim rather
 * than translated, so a missing name points the model at a tool that is not
 * there.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppDocument,
  DEFAULT_TRIGGER_ID,
  type Principal,
  type RunContext,
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
} from "@vendoai/core";
import {
  type ComponentRegistry,
} from "@vendoai/apps/contract";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_verbs" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "s_verbs" };

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-verbs-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** Two host components, so the composed deployment has a catalog behind it. */
const catalog: ComponentRegistry = {
  InvoiceTable: {
    component: null,
    description: "A sortable table of invoices with amounts and due dates.",
  },
  SpendChart: {
    component: null,
    description: "A bar chart of spending by category over time.",
  },
} as unknown as ComponentRegistry;

const app = (id: string, extra: Partial<AppDocument> = {}): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Verbs app",
  ui: "tree",
  tree: {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "ok" } }],
  },
  ...extra,
} as AppDocument);

async function compose(): Promise<{ vendo: Vendo; store: VendoStore }> {
  const store = await tempStore();
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    catalog,
  });
  await store.ensureSchema();
  return { vendo, store };
}

describe("the vendo verbs are on the one registry", () => {
  it("enumerates validate and schedule as guarded descriptors", async () => {
    const { vendo } = await compose();
    const names = (await vendo.guardedTools.descriptors(ctx)).map((descriptor) => descriptor.name);

    // The verbs lane D shipped...
    expect(names).toContain("validate");
    expect(names).toContain("schedule");
    // ...and the records family under the names the shipped app documents use.
    // Renaming them would invalidate live apps for cosmetics (contract §8).
    expect(names).toContain("vendo_apps_data_list");
    expect(names).toContain("vendo_apps_data_put");
    expect(names).toContain("vendo_apps_data_delete");
  });

  it("carries the risk labels the law reads: schedule is a write, the rest are reads", async () => {
    const { vendo } = await compose();
    const byName = new Map((await vendo.guardedTools.descriptors(ctx))
      .map((descriptor) => [descriptor.name, descriptor]));

    expect(byName.get("validate")?.risk).toBe("read");
    // Arming future unattended behaviour is a write, not a read.
    expect(byName.get("schedule")?.risk).toBe("write");
  });
});

describe("validate", () => {
  it("checks a stored app through the real checking floor", async () => {
    const { vendo } = await compose();
    await vendo.apps.importApp(app("app_seed"), ctx);
    const [stored] = await vendo.apps.list(ctx);

    const outcome = await vendo.guardedTools.execute(
      { id: "c3", tool: "validate", args: { appId: stored?.id } },
      ctx,
    );
    expect(outcome.status).toBe("ok");
    const output = (outcome as { output: { ok: boolean; findings: unknown[] } }).output;
    expect(output.ok).toBe(true);
    expect(output.findings).toEqual([]);
  });

  it("returns FINDINGS for a broken app, never a tool error", async () => {
    // The distinction is the whole point: an error reads to a model as "the tool
    // is broken", findings read as "your app is wrong". Only the second one
    // gets fixed.
    const { vendo } = await compose();
    const broken = app("app_broken");
    broken.tree!.nodes = [{ id: "root", component: "NoSuchComponent" }];
    await vendo.apps.importApp(broken, ctx);
    const stored = (await vendo.apps.list(ctx)).find(({ name }) => name === "Verbs app");

    const outcome = await vendo.guardedTools.execute(
      { id: "c4", tool: "validate", args: { appId: stored?.id } },
      ctx,
    );
    expect(outcome.status).toBe("ok");
    const output = (outcome as { output: { ok: boolean; findings: Array<{ message: string }> } }).output;
    expect(output.ok).toBe(false);
    expect(output.findings.length).toBeGreaterThan(0);
    expect(output.findings.every((finding) => typeof finding.message === "string")).toBe(true);
  });

  it("refuses a call that names nothing to check", async () => {
    // Answering "ok, no findings" for an empty request told the model its app was
    // fine when nothing had been examined — the worst lie a checker can tell.
    const { vendo } = await compose();
    const outcome = await vendo.guardedTools.execute(
      { id: "c5", tool: "validate", args: {} },
      ctx,
    );
    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
  });

  it("is owner-scoped: another subject's appId is a not-found, not a peek", async () => {
    const { vendo } = await compose();
    await vendo.apps.importApp(app("app_owned"), ctx);
    const [stored] = await vendo.apps.list(ctx);

    const stranger: RunContext = {
      ...ctx,
      principal: { kind: "user", subject: "user_stranger" },
    };
    const outcome = await vendo.guardedTools.execute(
      { id: "c6", tool: "validate", args: { appId: stored?.id } },
      stranger,
    );
    // The port throws not-found; the verb registry turns a port failure into a
    // sentence rather than leaking our internals into the transcript.
    expect(outcome.status).toBe("error");
  });
});

describe("schedule", () => {
  it("changes the cron on an app that declares a schedule trigger", async () => {
    const { vendo } = await compose();
    await vendo.apps.importApp(
      app("app_sched", {
        triggers: [{
          id: DEFAULT_TRIGGER_ID,
          on: { kind: "schedule", cron: "0 9 * * *" },
          run: { kind: "agentic", prompt: "summarise yesterday" },
        }],
      }),
      ctx,
    );
    const [stored] = await vendo.apps.list(ctx);

    const outcome = await vendo.guardedTools.execute(
      { id: "c7", tool: "schedule", args: { appId: stored?.id, cron: "30 7 * * 1" } },
      ctx,
    );
    expect(outcome.status).toBe("ok");
    expect((outcome as { output: { cron: string } }).output.cron).toBe("30 7 * * 1");

    // The stored document really changed — the verb is a write, not a report.
    const after = await vendo.apps.get(stored?.id as never, ctx);
    expect(after?.triggers?.[0]?.on).toEqual({ kind: "schedule", cron: "30 7 * * 1" });
  });

  it("refuses an app with no automation to schedule, and says what to do instead", async () => {
    const { vendo } = await compose();
    await vendo.apps.importApp(app("app_plain"), ctx);
    const [stored] = await vendo.apps.list(ctx);

    const outcome = await vendo.guardedTools.execute(
      { id: "c8", tool: "schedule", args: { appId: stored?.id, cron: "0 9 * * *" } },
      ctx,
    );
    // A cron needs something to run; authoring that is an edit, not a cron.
    expect(outcome.status).toBe("error");
  });

  it("refuses a call missing either half", async () => {
    const { vendo } = await compose();
    const outcome = await vendo.guardedTools.execute(
      { id: "c9", tool: "schedule", args: { appId: "app_x" } },
      ctx,
    );
    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
  });
});
