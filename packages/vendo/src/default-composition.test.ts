/**
 * THE equivalence test for the pack removal.
 *
 * `createVendo()` with nothing configured composes one tool registry and one
 * skills store. Deleting the pack noun moved WHERE those two sets are assembled;
 * it must not move WHAT is in them. The expected sets below are literals,
 * transcribed from the composition as it stood before the refactor, so the test
 * fails if a single tool or skill is added, dropped or renamed on the way.
 *
 * Read through the real composition on purpose: the registry via
 * `vendo.actions` (the one registry every door shares) and the skills via a
 * scripted harness's own `turn.skills.list()` (the mount IS the store — nothing
 * registers anywhere else).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "./server.js";

/** Every tool a default `createVendo()` puts in the one registry. */
const DEFAULT_TOOL_NAMES = [
  "ask_user",
  "schedule",
  "search_components",
  "validate",
  "vendo_apps_data_delete",
  "vendo_apps_data_list",
  "vendo_apps_data_put",
  "vendo_apps_open",
  "vendo_apps_pin",
  "vendo_apps_rebase_pin",
  "vendo_apps_unpin",
  "vendo_make",
] as const;

/** Every skill a default `createVendo()` mounts at /host/skills. */
const DEFAULT_SKILL_NAMES = ["building-apps"] as const;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-default-composition-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const principal: Principal = { kind: "user", subject: "user_equivalence" };

const request = (path: string, body: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const userMessage = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

/** The composed sets, read the way the runtime reads them. */
async function composedSets(): Promise<{ tools: string[]; skills: string[] }> {
  const skills: string[] = [];
  const vendo = createVendo({
    // Never reached: the harness below is scripted, and a real model would make
    // this test measure a provider instead of the composition.
    model: {} as LanguageModel,
    principal: async () => principal,
    store: await tempStore(),
    harness: defineHarness({
      name: "scripted",
      // eslint-disable-next-line require-yield -- the turn only reads the mount.
      async *run(turn) {
        skills.push(...(await turn.skills.list()).map(({ name }) => name));
      },
    }),
  });

  await (await vendo.handler(request("/threads", {
    threadId: "thr_equivalence",
    message: userMessage("m1", "hello"),
  }))).text();

  const tools = (await vendo.actions.descriptors()).map(({ name }) => name);
  return { tools: tools.sort(), skills: skills.sort() };
}

describe("the default composition", () => {
  it("puts exactly the same tools in the one registry as it always has", async () => {
    const { tools } = await composedSets();
    expect(tools).toEqual([...DEFAULT_TOOL_NAMES]);
  });

  it("mounts exactly the same skills as it always has", async () => {
    const { skills } = await composedSets();
    expect(skills).toEqual([...DEFAULT_SKILL_NAMES]);
  });
});
