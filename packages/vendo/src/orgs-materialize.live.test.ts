/**
 * The LIVE leg: two real people, one org, a shared app — and a real e2b box.
 *
 * The offline sibling (`orgs-materialize.test.ts`) proves the two gates with a
 * scripted SDK loop, which means it proves OUR seams and not the model's hands.
 * This one removes the last stand-in: a real machine, the real box image (the
 * one `packages/apps/box/build-template.mjs` bakes, which carries the walk rule
 * this lane changed), a real Claude Agent SDK session, and a real model deciding
 * for itself which file to open. What is asserted is only what the user would
 * see: Kim asks for a change to the TEAM's app, and Dana sees it.
 *
 * Gated on `E2B_API_KEY` + `ANTHROPIC_API_KEY` + `VENDO_BOX_TEMPLATE`, like every
 * `.live.test.ts`. No MCP door is composed on purpose: the subject here is the
 * workspace, and a box reaching a door needs a public origin this test has no
 * business minting. The harness warns once and runs with its own hands, which
 * is exactly the deployment shape a workspace-only host has.
 *
 * **The template matters here**, because this lane changes the box IMAGE (the
 * `/session/collect` walk in `packages/apps/box/turn-routes.mjs`): a run against
 * an image baked before the change collects `/user/` paths only and the team
 * file's edit never leaves the box. Proven on `vendo-box-orgs`
 * (`cnbt9dwz9ktvlplqhlq1`), a LANE-named template — never the shared `vendo-box`
 * id that production and every other consumer boot from, which is re-baked once
 * from the merged head. The id stays in the environment rather than in this
 * file so the same test runs against the shared image after the merge.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import type { UIMessage } from "ai";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Membership,
  type Principal,
  type RunContext,
} from "@vendoai/core";
import type { SandboxAdapter } from "@vendoai/apps";
import { e2bSandbox } from "@vendoai/apps/e2b";
import { claudeCode } from "@vendoai/harnesses/claude-code";
import { appAccess, createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "./server.js";

// A named secret can EXIST and be empty (`infisical secrets get` exits 0 either
// way), and an empty template id fails the provider with
// `400: Invalid template reference` long after the gate has let the test run.
// So the gate checks for content, not for presence.
const set = (name: string): boolean => (process.env[name] ?? "") !== "";
const ready = set("E2B_API_KEY") && set("ANTHROPIC_API_KEY") && set("VENDO_BOX_TEMPLATE");
const live = ready ? describe : describe.skip;
const MODEL = process.env["VENDO_LIVE_MODEL"] ?? "claude-sonnet-4-5";

const ORG = "acme";
const APP = "app_quarterly";
const APP_PATH = `/orgs/${ORG}/apps/${APP}/app.vendo`;
const SEEDED = '<App name="Quarterly Report">\n  <Heading text="Q2 revenue" />\n</App>\n';

const dana: Principal = { kind: "user", subject: "dana" };
const kim: Principal = { kind: "user", subject: "kim" };

const memberships: Record<string, Membership[]> = {
  dana: [{ org: ORG, display: "Acme", admin: true }],
  kim: [{ org: ORG, display: "Acme" }],
};

const ctxOf = (principal: Principal): RunContext => ({
  principal,
  memberships: memberships[principal.subject] ?? [],
  venue: "app",
  presence: "present",
  sessionId: `s_${principal.subject}`,
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The sandbox seam the harness actually consumes. Declared here rather than
 *  imported because `box.ts` keeps it STRUCTURAL on purpose — the subpath does
 *  not publish it, so naming the shape locally is the intended use. */
interface SandboxMachineLike {
  id: string;
  request(req: Record<string, unknown>): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
  destroy(): Promise<void>;
}
interface SandboxAdapterLike {
  create(spec: { template?: string; env: Record<string, string>; allowedDomains?: string[] }): Promise<SandboxMachineLike>;
  destroy(snapshotRef: string): Promise<void>;
}

/**
 * The e2b adapter, plus a reap.
 *
 * A conversation box is destroyed by an IDLE TIMER armed at `release()`
 * (`BOX_IDLE_TTL_MS`, 5 min) — and that timer is `unref()`'d, so a vitest
 * process that exits first never fires it and the machine is left running on
 * the provider's side until its own `timeoutMs` catches it. A test must not
 * leave real infrastructure behind, so every machine this adapter hands out is
 * destroyed in `afterEach`.
 *
 * Safe against the pool: `boxMachine` PROBES a pooled entry with `hello` before
 * reusing it and boots a fresh box when the probe fails, so a reaped machine can
 * never be handed to a later turn as a corpse.
 */
function reapingSandbox(): SandboxAdapterLike {
  const inner = e2bSandbox({
    apiKey: process.env["E2B_API_KEY"]!,
    timeoutMs: 10 * 60_000,
  }) as unknown as SandboxAdapterLike;
  const taken: SandboxMachineLike[] = [];
  cleanups.push(async () => {
    for (const machine of taken.splice(0)) {
      await machine.destroy().catch(() => undefined);
    }
  });
  return {
    async create(spec) {
      const machine = await inner.create(spec);
      taken.push(machine);
      return machine;
    },
    destroy: (ref) => inner.destroy(ref),
  };
}

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-orgs-live-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  });
  await store.ensureSchema();
  return store;
}

const seeded = (id: string, name: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name,
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
});

/** Whose request this is — set per call, the way a real session would. */
let acting: Principal = kim;

const userMessage = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

live("a real box reaches a real team's app", () => {
  it("Kim edits the TEAM's Quarterly Report, and Dana sees the change", async () => {
    const store = await tempStore();
    const vendo = createVendo({
      model: {} as LanguageModel,
      store,
      sandbox: reapingSandbox() as unknown as SandboxAdapter,
      harness: claudeCode({ model: MODEL, maxTurns: 14 }),
      auth: {
        principal: async () => acting,
        memberships: async (principal: Principal) => memberships[principal.subject] ?? [],
      },
    });

    // Dana, the org admin, owns the team's app and shares it with Kim.
    await store.records("vendo_apps").put({
      id: APP,
      data: { subject: ORG, enabled: false, doc: seeded(APP, "Quarterly Report") },
      refs: { subject: ORG },
    });
    await appAccess(store).grant(ctxOf(dana), APP, `user:${kim.subject}`, "editor");
    acting = dana;
    const danas = await vendo.harness.workspace(dana);
    await danas.writeFile(APP_PATH, SEEDED);
    expect(await danas.commit()).toEqual({ status: "ok", changed: [APP_PATH] });

    // Kim — an ordinary member, not the owner — asks for the change in her own
    // words. Nothing tells the model which mount to look in.
    acting = kim;
    const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "thr_live_org",
        message: userMessage(
          "m1",
          "Our team's Quarterly Report app says 'Q2 revenue'. Change that heading to say"
          + " 'Q3 revenue' and save it. Edit the existing file — do not make a copy.",
        ),
      }),
    }));
    expect(response.status).toBe(200);
    const wire = await response.text();

    // Dana reads the SAME path. One app, two people (§9.7).
    acting = dana;
    const after = await (await vendo.harness.workspace(dana)).readFile(APP_PATH);
    console.log("[live org edit]", JSON.stringify({ wire: wire.slice(0, 1500), after }));
    expect(wire).not.toContain("missing its workspace machine");
    expect(after).toContain("Q3 revenue");

    // The MID-TURN paint, asserted rather than admired: a `data-vendo-view` for
    // this app on the wire is the only proof `HOT_PATH_WATCH` covers `/orgs`.
    // Without it a regression there costs the user ~50s of blank pane and this
    // test would still pass, because turn-end sync lands the file either way.
    const views = wire
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice("data: ".length)) as { type?: string; data?: { appId?: string } })
      .filter((event) => event.type === "data-vendo-view");
    expect(views.map((view) => view.data?.appId)).toContain(APP);

    // And it edited the team's file rather than inventing a personal duplicate,
    // which is the OTHER shape the old bug produced.
    acting = kim;
    const kims = await vendo.harness.workspace(kim);
    expect(kims.getAllPaths().filter((path) => path.startsWith("/user/apps/"))).toEqual([]);
  }, 600_000);
});
