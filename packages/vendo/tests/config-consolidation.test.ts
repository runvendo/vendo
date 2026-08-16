/**
 * The §10 consolidation, proven on real compositions.
 *
 * Two claims, and they are the whole acceptance bar: a host on the OLD shape
 * still boots and works (with a deprecation warning naming the move), and the
 * SAME host on the NEW shape boots and works identically. Additive-first means
 * nothing shipped breaks — a claim only a side-by-side can make.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREATE_VENDO_CONFIG_KEYS, DEPRECATED_CONFIG_KEYS, resetDeprecationWarnings } from "../src/config-keys.js";
import { createVendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  resetDeprecationWarnings();
});

const principal: Principal = { kind: "user", subject: "user_config" };

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-config-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const hostTool = (name: string) => ({
  name,
  description: `GET tool ${name}`,
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  risk: "read" as const,
  binding: { kind: "route" as const, method: "GET" as const, path: `/api/${name}`, argsIn: "query" as const },
});

function warnings(): { lines: string[] } {
  const lines: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  });
  return { lines };
}

describe("the `tools` slot (§10) — the host's own declared tools", () => {
  it("composes the same tools the deprecated `profile.tools` did", async () => {
    const store = await tempStore();
    const vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store,
      tools: [hostTool("host_invoices_list")],
    });
    const names = (await vendo.actions.descriptors()).map((descriptor) => descriptor.name);
    expect(names).toContain("host_invoices_list");
  });

  it("OLD shape and NEW shape compose the same host-tool surface", async () => {
    const old = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore(),
      profile: { tools: [hostTool("host_invoices_list")] },
    });
    const next = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore(),
      tools: [hostTool("host_invoices_list")],
    });
    const namesOf = async (vendo: Awaited<ReturnType<typeof createVendo>>) =>
      (await vendo.actions.descriptors()).map((descriptor) => descriptor.name).sort();
    expect(await namesOf(old)).toEqual(await namesOf(next));
  });

  it("the slot wins when a host sets both, and says so once", async () => {
    const { lines } = warnings();
    const vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore(),
      tools: [hostTool("host_from_slot")],
      profile: { tools: [hostTool("host_from_profile")] },
    });
    const names = (await vendo.actions.descriptors()).map((descriptor) => descriptor.name);
    expect(names).toContain("host_from_slot");
    expect(names).not.toContain("host_from_profile");
    expect(lines.join("\n")).toContain("profile.tools");
  });

  it("an EXECUTABLE-only `tools:` contributes its tool without erasing the declarations", async () => {
    // The two shapes share one key, and only the declaration half feeds `.vendo`
    // semantics. Filtering it to an empty list and calling that "the host set
    // the slot" silently deleted every declared host tool — and blinded the boot
    // collision gate, which then read no tools.json and passed everything.
    const vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore(),
      tools: [{
        name: "check_report",
        description: "Check one compliance report.",
        inputSchema: { type: "object", properties: {} },
        risk: "read" as const,
        execute: async () => ({ status: "clean" }),
      }],
      profile: { tools: [hostTool("host_invoices_list")] },
    });

    const names = (await vendo.actions.descriptors()).map((descriptor) => descriptor.name);
    expect(names).toContain("check_report");
    expect(names).toContain("host_invoices_list");
  });
});

describe("the model knobs that are GONE — a boot error naming the seat", () => {
  it.each([
    ["model", { model: {} as LanguageModel }, "models.default"],
    ["paint", { paint: { model: {} as LanguageModel } }, "models.apps"],
    ["paint", { paint: { disabled: true } }, "apps: false"],
  ])("refuses `%s` and names where it went", async (_key, removed, destination) => {
    const config = {
      ...removed,
      principal: async () => principal,
      store: await tempStore(),
    } as Parameters<typeof createVendo>[0];
    // A silently dropped model key is a deployment thinking with the wrong
    // model, or an apps lane the host believes is off. Refuse instead.
    expect(() => createVendo(config)).toThrow(destination);
  });

  it("an OLD-shape host on the surviving deprecation boots green and is told what to change", async () => {
    const { lines } = warnings();
    const vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore(),
      profile: { tools: [hostTool("host_invoices_list")] },
    });
    expect(typeof vendo.handler).toBe("function");
    // A warning that does not say where to go is a warning a host cannot act on.
    expect(lines.join("\n")).toContain("tools:");
  });

  it("warns ONCE per key, not once per composition", async () => {
    const { lines } = warnings();
    for (let index = 0; index < 3; index += 1) {
      createVendo({
        models: { default: {} as LanguageModel },
        principal: async () => principal,
        store: await tempStore(),
        profile: { tools: [hostTool("host_invoices_list")] },
      });
    }
    expect(lines.filter((line) => line.includes("`profile.tools` is deprecated"))).toHaveLength(1);
  });

  it("says nothing at all for a host already on the new shape", async () => {
    const { lines } = warnings();
    createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore(),
      tools: [hostTool("host_invoices_list")],
    });
    expect(lines.filter((line) => line.includes("deprecated"))).toEqual([]);
  });

  it("every deprecated key is a real key of the config", () => {
    for (const key of Object.keys(DEPRECATED_CONFIG_KEYS)) {
      // `profile.tools` is a nested spelling; its head is the real key.
      expect(CREATE_VENDO_CONFIG_KEYS).toContain(key.split(".")[0]);
    }
  });
});
