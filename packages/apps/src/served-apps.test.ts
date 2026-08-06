import { VENDO_APP_FORMAT, VendoError, type AppDocument, type RunContext, type ScreenAssembler, type ToolRegistry, type VendoTheme } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createAppHistory } from "./history.js";
import { createApps } from "./index.js";
import { fakeBoxSandbox, type FakeBoxAgent } from "./testing/fake-box.js";
import { basicLanguageModel, guardFixture, memoryStore, seedAppRow } from "./testing/index.js";

/**
 * execution-v2 Wave 4 — layer 3 (machine-everything), experimental, on the
 * fake-box substrate. Covers: the experimental flag's clean refusals (create,
 * edit, open, flip), the 2→3 flow (tree keeps serving until the box's own
 * checks pass, then the surface flips), wake-on-open, the served URL shape,
 * and the theming handoff query param.
 */

const ctx = (subject = "user_ada"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

const treeApp = (overrides: Partial<AppDocument> = {}): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_served",
  name: "Invoice board",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: ["title"] },
      { id: "title", component: "Text", source: "prewired", props: { text: "Invoices" } },
    ],
  } as AppDocument["tree"],
  ...overrides,
});

const LAYER3_INSTRUCTION = "Make me a full kanban board for my invoices with drag-and-drop between columns";

/** A box agent that builds a real web app in the box: GET / serves a page and
 *  an fn coexists beside it — exactly the layer-3 shape. */
const kanbanAgent: FakeBoxAgent = ({ box }) => {
  box.pages.set("/", "<!doctype html><title>Invoice kanban</title><h1>Kanban</h1>");
  box.fns.set("listInvoices", () => ({ invoices: [] }));
  box.manifest = {};
  return { ok: true, summary: "serving the kanban web app", filesChanged: ["/app/server.js"], testsRun: 2, fns: ["listInvoices"], servesUi: true };
};

/**
 * The plan the escalating screen agent leaves behind, driven by what was asked.
 *
 * Layer 3 is declared in the PLAN: `<Server kind="box" served>` for an
 * interaction no component can express, and a plain `<Server kind="box">` for
 * ordinary custom server work. That declaration is one of the two signals the
 * surface flip needs — the host's own `GET /` check is the other.
 */
const escalatedPlanFor = (request: string): string => {
  const server = /kanban|drag-and-drop/i.test(request)
    ? '<Server kind="box" served why="Dragging cards between columns is an interaction no component can express."/>'
    : '<Server kind="box" why="Custom matching logic no tool composition can express."/>';
  return `<Plan name="Invoice board">
  <Group tab="Board"><Leaf component="Text" purpose="the board"/></Group>
  ${server}
</Plan>`;
};

const PROXY_PATH = (appId: string): string => `/api/vendo/apps/${appId}/serve/`;

const setup = (options: {
  agent?: FakeBoxAgent;
  theme?: VendoTheme;
  /** Compose WITHOUT the wire's authenticated served door (an unmounted wire). */
  proxy?: boolean;
  /** Re-compose over an existing world, to say the same store two ways. */
  store?: ReturnType<typeof memoryStore>;
  sandbox?: ReturnType<typeof fakeBoxSandbox>;
} = {}) => {
  const store = options.store ?? memoryStore();
  const guard = guardFixture();
  const sandbox = options.sandbox ?? fakeBoxSandbox({ agent: options.agent ?? kanbanAgent });
  /** The ask the screen agent last escalated: `escalatedPlan` is read per app,
   *  so the plan handed to the ladder is the one THIS ask left behind. */
  let escalated = "";
  const screen: ScreenAssembler = {
    assemble: async (request) => {
      escalated = request.request;
      return { kind: "escalate", why: "this needs real code, not an arrangement of components" };
    },
  };
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    // Nothing on these paths generates: the screen agent escalates, and the box
    // is what builds. The model is here because a runtime without one refuses to
    // edit at all.
    model: basicLanguageModel(),
    screen,
    escalatedPlan: async () => escalatedPlanFor(escalated),
    ...(options.theme === undefined ? {} : { theme: options.theme }),
    machine: { sandbox, buildEnv: () => ({ PORT: "8080" }), implicitDomains: ["host.vendo.test"], boxEditPollMs: 5 },
    // The wire fills this with its own base path; the runtime never invents it.
    // EVERY served app is answered with it now, the owner's own included.
    ...(options.proxy === false ? {} : { servedProxyPath: PROXY_PATH }),
  });
  return { store, guard, sandbox, runtime };
};

describe("a served app needs a machine, and a door to serve it through", () => {
  // The pre-emptive typed refusal on create and edit is GONE with the regex
  // judge that guessed a layer-3 ask from the instruction text
  // (`instructionRequiresServedApp`). A lane this host does not have is now
  // stated to the brain as fact before it plans, and the ask comes back as an
  // honest <Cannot> the person reads — covered by build-failure.test.ts.

  /** This used to be the served flag's refusal. The flag is gone, and the
      condition it was standing in front of is the real one: a served document
      with no machine has no surface anywhere. */
  it("refuses open() on a served app that has no machine, saying its surface is gone", async () => {
    const { store, runtime } = setup();
    await seedAppRow(store, treeApp({ ui: "http", tree: undefined }), "user_ada");

    const error = await runtime.open("app_served", ctx()).then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VendoError);
    expect((error as VendoError).code).toBe("validation");
    expect((error as VendoError).message).toContain("has no machine");
  });

  /** The backstop for a served row that arrives from somewhere else — an
      import, or a deployment that dropped its wire after building the app. The
      lane gate stops one from ever being BUILT here (lanes.test.ts); if one
      exists anyway, the answer is a refusal naming the fix, never the sandbox
      provider's unchecked URL. */
  it("refuses a served app it has no authenticated door for, and names the wire", async () => {
    const { store, sandbox, runtime } = setup({ proxy: false });
    const box = await sandbox.create({ env: {}, template: "node" });
    const snapshotRef = await box.snapshot();
    const machinesBefore = sandbox.machines.length;
    await seedAppRow(store, treeApp({
      ui: "http",
      tree: undefined,
      machine: { snapshotRef, provisionedAt: "2026-08-01T00:00:00.000Z" },
    }), "user_ada");

    const error = await runtime.open("app_served", ctx()).then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VendoError);
    expect((error as VendoError).code).toBe("not-implemented");
    expect((error as VendoError).message).toContain("mount the Vendo wire");
    // No provider URL leaked out of the refusal, and no machine was spent.
    expect((error as VendoError).message).not.toContain("fake-box.test");
    expect(sandbox.machines.length).toBe(machinesBefore);
  });

  it("blocks the surface flip when the box self-declares a served app the plan never asked for (de-graduation guard)", async () => {
    // A layer-2 instruction whose box work sneaks in servesUi. The plan asked
    // for a layer-2 box, so the flip is refused — loudly, in the result issues —
    // and the tree keeps serving. This is the whole safety net now that no flag
    // stands in front of it: a box must never replace a tree the person did not
    // ask to lose.
    const { store, runtime } = setup({ agent: kanbanAgent });
    await seedAppRow(store, treeApp(), "user_ada");
    // Wave 9 — a box-rung instruction (custom logic): schedule-y phrasing now
    // rides the automations ladder and would never reach the box.
    const result = await runtime.edit("app_served", "Reconcile my invoices with custom matching logic and store the results", ctx());
    expect(result.app.ui).toBe("tree");
    expect(result.app.tree).toBeDefined();
    expect(result.issues?.some((issue) => issue.includes("plan never asked for one"))).toBe(true);
    // open() still serves the tree.
    const surface = await runtime.open("app_served", ctx());
    expect(surface.kind).toBe("tree");
  });
});

describe("graduation 2→3", () => {
  it("flips the surface only after the box serves a verified web app (tree gone, rung 3)", async () => {
    const { store, runtime } = setup();
    await seedAppRow(store, treeApp(), "user_ada");

    const result = await runtime.edit("app_served", LAYER3_INSTRUCTION, ctx());

    expect(result.failure).toBeUndefined();
    expect(result.graduated).toBe(true);
    expect(result.app.ui).toBe("http");
    expect(result.app.tree).toBeUndefined();
    expect(result.app.machine?.snapshotRef).toMatch(/^fakebox:/);
    expect(result.version.rung).toBe(3);
    // /fn endpoints coexist beside the served pages.
    const fn = await runtime.call("app_served", "fn:listInvoices", {}, ctx());
    expect(fn.status).toBe("ok");
  });

  it("keeps the tree serving when the box edit fails (no flip, rollback)", async () => {
    const { store, runtime } = setup({
      agent: () => ({ ok: false, summary: "could not build the app", filesChanged: [], testsRun: 0 }),
    });
    await seedAppRow(store, treeApp(), "user_ada");

    const result = await runtime.edit("app_served", LAYER3_INSTRUCTION, ctx());

    expect(result.failure).toMatchObject({ code: "edit-rejected" });
    const after = await runtime.get("app_served", ctx());
    expect(after?.ui).toBe("tree");
    expect(after?.tree).toBeDefined();
    expect((await runtime.open("app_served", ctx())).kind).toBe("tree");
  });

  it("keeps the tree serving when the box claims a served app but the root check fails", async () => {
    // servesUi without an actual page: the host's own GET / verification
    // refuses the flip; the box work (machine, fns) still lands.
    const { store, runtime } = setup({
      agent: ({ box }) => {
        box.fns.set("listInvoices", () => ({ invoices: [] }));
        return { ok: true, summary: "claims a web app", filesChanged: [], testsRun: 0, fns: ["listInvoices"], servesUi: true };
      },
    });
    await seedAppRow(store, treeApp(), "user_ada");

    const result = await runtime.edit("app_served", LAYER3_INSTRUCTION, ctx());

    expect(result.app.ui).toBe("tree");
    expect(result.app.tree).toBeDefined();
    expect(result.issues?.some((issue) => issue.includes("served"))).toBe(true);
  });
});

describe("serving through the door + the keepalive ride", () => {
  const flipped = async (options: Parameters<typeof setup>[0] = {}) => {
    const world = setup(options);
    await seedAppRow(world.store, treeApp(), "user_ada");
    const result = await world.runtime.edit("app_served", LAYER3_INSTRUCTION, ctx());
    expect(result.app.ui).toBe("http");
    return world;
  };

  it("open() hands back this deployment's proxy URL, never the box's public ingress", async () => {
    const { sandbox, runtime } = await flipped();
    // The 2→3 edit ends asleep (snapshot). open() no longer wakes anything: the
    // URL it hands out is the proxy, and the proxy wakes the machine on the
    // first forwarded request — after it has re-checked access. An owner opening
    // their own app therefore costs no machine either.
    const machinesBefore = sandbox.machines.length;

    const surface = await runtime.open("app_served", ctx());

    expect(surface.kind).toBe("http");
    if (surface.kind !== "http") throw new Error("unreachable");
    expect(surface.url).toBe("/api/vendo/apps/app_served/serve/");
    expect(surface.url).not.toMatch(/fake-box\.test/);
    expect(sandbox.machines.length).toBe(machinesBefore);

    // The door that URL names is the one that wakes the box and serves the page.
    const page = await runtime.serve("app_served", { method: "GET", path: "/" }, ctx());
    expect(page.status).toBe(200);
    expect(new TextDecoder().decode(page.body)).toContain("Kanban");
    expect(sandbox.machines.length).toBeGreaterThan(machinesBefore);
  });

  it("hands the host theme to the served app as a query param it MAY consume", async () => {
    const theme: VendoTheme = {
      colors: {
        background: "#ffffff", surface: "#f7f7f8", text: "#111111", muted: "#666666",
        accent: "#3457dc", accentText: "#ffffff", danger: "#b3261e", border: "#e3e3e6",
      },
      typography: { fontFamily: "Inter, sans-serif", baseSize: "16px" },
      radius: { small: "6px", medium: "10px", large: "16px" },
      density: "comfortable",
      motion: "full",
    };
    const { runtime } = await flipped({ theme });

    const surface = await runtime.open("app_served", ctx());

    if (surface.kind !== "http") throw new Error("expected an http surface");
    // The proxy forwards the query string into the box, so the brand handoff
    // survives the flip to a checked door.
    const url = new URL(surface.url, "http://host.test");
    expect(url.pathname).toBe("/api/vendo/apps/app_served/serve/");
    const handed = url.searchParams.get("vendoTheme");
    expect(handed).not.toBeNull();
    expect(JSON.parse(handed as string)).toEqual(theme);
  });

  it("ping on an awake machine reports awake without waking anything new (the keepalive ride)", async () => {
    // Wave 7 H2 — the embed surface's activity ping: one cheap HEAD through
    // the idle-tracked machine wrapper, which is the activity signal that
    // re-arms the idle timer (and rides any provider TTL extension).
    const { sandbox, runtime } = await flipped();
    // open() hands out the proxy URL and wakes nothing; the machine comes awake
    // on the first request through that door, which is what this ping follows.
    await runtime.serve("app_served", { method: "GET", path: "/" }, ctx());
    const machinesBefore = sandbox.machines.length;

    const pinged = await runtime.machine.ping("app_served", ctx());

    expect(pinged).toEqual({ state: "awake" });
    expect(sandbox.machines.length).toBe(machinesBefore);
  });

  it("ping on a sleeping machine wakes it and reports woke (the embed reloads once awake)", async () => {
    // The 2→3 edit ends asleep. A ping that finds the machine asleep is the
    // load-failure/stale-URL signal: it wakes the box and reports "woke" so
    // the embed shows the resuming state and re-opens for the fresh URL.
    const { sandbox, runtime } = await flipped();
    const machinesBefore = sandbox.machines.length;

    const pinged = await runtime.machine.ping("app_served", ctx());

    expect(pinged).toEqual({ state: "woke" });
    expect(sandbox.machines.length).toBeGreaterThan(machinesBefore);
    // The wake is shared: the follow-up open() reuses the live machine
    // instead of waking a second one.
    const afterPing = sandbox.machines.length;
    const surface = await runtime.open("app_served", ctx());
    expect(surface.kind).toBe("http");
    expect(sandbox.machines.length).toBe(afterPing);
  });

  it("ping refuses an app that has no machine", async () => {
    const world = setup();
    await seedAppRow(world.store, treeApp(), "user_ada");
    const error = await world.runtime.machine.ping("app_served", ctx()).then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VendoError);
    expect((error as VendoError).code).toBe("validation");
  });

  it("refuses to fork a served app (its surface lives in the machine, which never travels)", async () => {
    const { runtime } = await flipped();
    const error = await runtime.fork("app_served", ctx()).then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VendoError);
    expect((error as VendoError).code).toBe("conflict");
    expect((error as VendoError).message).toContain("cannot be forked");
  });

  it("every edit of a served app rides the box path (tree dialect is gone for it)", async () => {
    const { sandbox, runtime } = await flipped();
    const machinesBefore = sandbox.machines.length;
    const result = await runtime.edit("app_served", "Make the board header blue", ctx());
    expect(result.failure).toBeUndefined();
    expect(result.app.ui).toBe("http");
    expect(sandbox.machines.length).toBeGreaterThan(machinesBefore);
  });

  /* DELETED with `experimentalMachines`: "keeps editing a served app whose
     machine already exists, even with layer 2 switched off". Layer 2 has no
     switch any more — the sandbox adapter's presence is the whole gate — so
     "off" now means there is no sandbox to wake the app's existing machine
     with, and the case the test described cannot be composed. The rule it
     guarded still holds and is still enforced in `machine.provision`: an
     already-provisioned app is never refused, only NEW provisioning is. */

  it("keeps version history at its 50 cap — the box path prunes like every other write", async () => {
    // The box path appends its own undo point (the box already landed the write,
    // so that version is real history the moment it exists) and is therefore the
    // third site the cap is applied at. Nothing pinned it: dropping its
    // `pruneHistory` call left the log growing past 50 with the suite green.
    const { store, runtime } = await flipped();
    const history = createAppHistory(store);
    const current = (await runtime.get("app_served", ctx()))!;
    // Filled to EXACTLY the cap, counting the version the 2→3 flip itself left —
    // the oldest one in the log, so it is the one the box edit's prune must drop.
    const existing = (await runtime.history("app_served", ctx()).list()).length;
    for (let index = 1; index <= 50 - existing; index += 1) {
      await history.append("app_served", current, {
        at: new Date(1_754_000_000_000 + index).toISOString(),
        intent: `Edit ${index}`,
        rung: 3,
      });
    }
    const before = await runtime.history("app_served", ctx()).list();
    expect(before).toHaveLength(50);
    // The flip's own undo point is the oldest entry, so it is the one this
    // edit's version has to push out.
    expect(before.at(-1)?.intent).toBe(LAYER3_INSTRUCTION);

    const result = await runtime.edit("app_served", "Make the board header blue", ctx());
    expect(result.failure).toBeUndefined();

    const versions = await runtime.history("app_served", ctx()).list();
    // The cap held with this edit's version in it, and the oldest undo point in
    // the log — the one the 2→3 flip left — is what paid for it.
    expect(versions).toHaveLength(50);
    expect(versions[0]?.intent).toBe("Make the board header blue");
    expect(versions.filter(({ intent }) => intent === LAYER3_INSTRUCTION)).toEqual([]);
  });
});
