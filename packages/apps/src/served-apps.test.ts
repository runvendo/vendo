import { VENDO_APP_FORMAT, VendoError, type AppDocument, type RunContext, type ToolRegistry, type VendoTheme } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import { fakeBoxSandbox, type FakeBoxAgent } from "./testing/fake-box.js";
import { guardFixture, memoryStore, scriptedLanguageModel, seedAppRow } from "./testing/index.js";

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

const setup = (options: {
  agent?: FakeBoxAgent;
  experimentalServedApps?: boolean;
  theme?: VendoTheme;
  edit?: string;
} = {}) => {
  const store = memoryStore();
  const guard = guardFixture();
  const sandbox = fakeBoxSandbox({ agent: options.agent ?? kanbanAgent });
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    model: scriptedLanguageModel(options.edit ?? '<Edit><SetName name="unused"/></Edit>'),
    ...(options.experimentalServedApps === undefined ? {} : { experimentalServedApps: options.experimentalServedApps }),
    ...(options.theme === undefined ? {} : { theme: options.theme }),
    machine: { sandbox, buildEnv: () => ({ PORT: "8080" }), implicitDomains: ["host.vendo.test"], boxEditPollMs: 5 },
  });
  return { store, guard, sandbox, runtime };
};

const expectServedAppsRefusal = async (run: () => Promise<unknown>): Promise<void> => {
  const error = await run().then(() => undefined, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(VendoError);
  expect((error as VendoError).code).toBe("not-implemented");
  expect((error as VendoError).message).toContain("experimentalServedApps");
};

describe("experimental flag OFF (the default)", () => {
  it("refuses layer-3 generation on create with a typed error naming the flag", async () => {
    const { runtime } = setup();
    await expectServedAppsRefusal(() => runtime.create({ prompt: LAYER3_INSTRUCTION }, ctx()));
  });

  it("refuses a layer-3 edit instruction the same way (no box work happens)", async () => {
    const { store, sandbox, runtime } = setup();
    await seedAppRow(store, treeApp(), "user_ada");
    await expectServedAppsRefusal(() => runtime.edit("app_served", LAYER3_INSTRUCTION, ctx()));
    expect(sandbox.machines).toHaveLength(0);
    // The app is untouched: still the tree.
    expect((await runtime.get("app_served", ctx()))?.ui).toBe("tree");
  });

  it("refuses open() on a served app that exists from elsewhere", async () => {
    const { store, runtime } = setup();
    await seedAppRow(store, treeApp({ ui: "http", tree: undefined }), "user_ada");
    await expectServedAppsRefusal(() => runtime.open("app_served", ctx()));
  });

  it("blocks the surface flip even when the box self-declares a served app (de-graduation guard)", async () => {
    // A layer-2 instruction whose box work sneaks in servesUi: the flag is
    // off, so the flip is refused — loudly, in the result issues — and the
    // tree keeps serving.
    const { store, runtime } = setup({
      agent: kanbanAgent,
      edit: '<Edit><Query id="data" tool="fn:listInvoices"/><Insert into="root"><Text text={data.summary}/></Insert></Edit>',
    });
    await seedAppRow(store, treeApp(), "user_ada");
    const result = await runtime.edit("app_served", "Watch my invoices on a schedule and store the results", ctx());
    expect(result.app.ui).toBe("tree");
    expect(result.app.tree).toBeDefined();
    expect(result.issues?.some((issue) => issue.includes("experimentalServedApps"))).toBe(true);
    // open() still serves the tree.
    const surface = await runtime.open("app_served", ctx());
    expect(surface.kind).toBe("tree");
  });
});

describe("experimental flag ON: graduation 2→3", () => {
  it("flips the surface only after the box serves a verified web app (tree gone, rung 3)", async () => {
    const { store, runtime } = setup({ experimentalServedApps: true });
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
      experimentalServedApps: true,
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
      experimentalServedApps: true,
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

describe("experimental flag ON: serving + wake-on-open", () => {
  const flipped = async (options: Parameters<typeof setup>[0] = {}) => {
    const world = setup({ experimentalServedApps: true, ...options });
    await seedAppRow(world.store, treeApp(), "user_ada");
    const result = await world.runtime.edit("app_served", LAYER3_INSTRUCTION, ctx());
    expect(result.app.ui).toBe("http");
    return world;
  };

  it("open() wakes the sleeping machine and returns the box's public ingress URL", async () => {
    const { sandbox, runtime } = await flipped();
    // The 2→3 edit ends asleep (snapshot); open() must wake a fresh machine.
    const machinesBefore = sandbox.machines.length;

    const surface = await runtime.open("app_served", ctx());

    expect(surface.kind).toBe("http");
    if (surface.kind !== "http") throw new Error("unreachable");
    expect(surface.url).toMatch(/^https:\/\/8080-box-\d+\.fake-box\.test\/?$/);
    expect(sandbox.machines.length).toBeGreaterThan(machinesBefore);
    // The wake resumed the snapshot: the served page is really there.
    const woken = sandbox.machines.at(-1);
    const page = await woken?.request({ method: "GET", path: "/" });
    expect(page?.status).toBe(200);
    expect(new TextDecoder().decode(page?.body)).toContain("Kanban");
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
    const url = new URL(surface.url);
    const handed = url.searchParams.get("vendoTheme");
    expect(handed).not.toBeNull();
    expect(JSON.parse(handed as string)).toEqual(theme);
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
});
