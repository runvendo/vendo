import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type RunContext,
  type ToolRegistry,
  type VendoTheme,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps, type AppsConfig, type AppsRuntime, type BoxRequest } from "./index.js";
import { fakeBoxSandbox } from "./testing/fake-box.js";
import { guardFixture, memoryStore, seedAppRow } from "./testing/index.js";
import { storeAccessFixture, seedGrantRows } from "./testing/app-access-fixture.js";

/**
 * Build contract §9.8 — served ORG apps are a wire door, not a snapshot with
 * viewers: `open()` hands back an authenticated proxy URL and `can(viewer)` is
 * checked against LIVE rows on every request through it. Personal served apps
 * keep today's behaviour byte for byte.
 */

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

const ctx = (subject: string, orgs: string[] = []): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `s_${subject}`,
  ...(orgs.length === 0 ? {} : { memberships: orgs.map((org) => ({ org })) }),
});

/** A layer-3 document: the machine serves the whole surface. `snapshotRef` has
    to name a snapshot the fake box actually holds, so setup() mints one. */
const servedApp = (id: string, snapshotRef: string, egress?: string[]): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Invoice kanban",
  ui: "http",
  machine: { snapshotRef, provisionedAt: "2026-08-01T00:00:00.000Z" },
  ...(egress === undefined ? {} : { egress }),
});

const setup = async (over: Partial<AppsConfig> = {}, guard = guardFixture()): Promise<{
  runtime: AppsRuntime;
  store: ReturnType<typeof memoryStore>;
  guard: ReturnType<typeof guardFixture>;
  /** A served app the fake box can actually resume, seeded under `subject`. */
  seed(id: string, subject: string, egress?: string[]): Promise<void>;
  sandbox: ReturnType<typeof fakeBoxSandbox>;
}> => {
  const store = memoryStore();
  const sandbox = fakeBoxSandbox();
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    appAccess: storeAccessFixture(store),
    multiParty: true,
    machine: { sandbox },
    // The wire fills this with its own base path; the runtime never invents it.
    servedProxyPath: (appId) => `/api/vendo/apps/${appId}/serve/`,
    ...over,
  });
  return {
    runtime,
    store,
    guard,
    sandbox,
    async seed(id, subject, egress) {
      const box = await sandbox.create({ env: {}, template: "node" });
      const snapshotRef = await box.snapshot();
      await seedAppRow(store, servedApp(id, snapshotRef, egress), subject);
    },
  };
};

describe("§9.8 — open() routes ORG-owned served apps through the proxy", () => {
  it("hands an org app the authenticated proxy URL, never the provider's", async () => {
    const { runtime, store, seed } = await setup();
    await seed("app_org_served", "acme");
    await seedGrantRows(store, "app_org_served", { "user:kim": "viewer" });

    const opened = await runtime.open("app_org_served", ctx("kim", ["acme"]));
    expect(opened).toEqual({
      kind: "http",
      url: "/api/vendo/apps/app_org_served/serve/",
    });
  });

  it("gives the org branch the SAME theme handoff the personal branch gets", async () => {
    // Without it a shared served app renders unthemed while the owner's own
    // copy of the very same app renders in the host's brand.
    const theme: VendoTheme = {
      colors: {
        background: "#fff", surface: "#fafafa", text: "#111", muted: "#666",
        accent: "#0a7", accentText: "#fff", danger: "#c00", border: "#ddd",
      },
      typography: { fontFamily: "Inter", baseSize: "15px" },
      radius: { small: "4px", medium: "8px", large: "16px" },
      density: "comfortable",
      motion: "full",
    };
    const { runtime, store, seed } = await setup({ theme });
    await seed("app_org_theme", "acme");
    await seedGrantRows(store, "app_org_theme", { "user:kim": "viewer" });

    const opened = await runtime.open("app_org_theme", ctx("kim", ["acme"]));
    expect((opened as { url: string }).url)
      .toBe(`/api/vendo/apps/app_org_theme/serve/?vendoTheme=${encodeURIComponent(JSON.stringify(theme))}`);
  });

  /** `can()` admits a bare `user:` grant on an org-held app with NO membership
      asserted — the grant is the whole permission, which is exactly what
      "share with one person" writes. Keying the proxy branch on MEMBERSHIPS
      alone handed that caller the provider's raw ingress URL: a
      bearer-by-obscurity capability URL with no per-request check, which is the
      thing §9.8's proxy exists to prevent. */
  it("routes a user-granted viewer who asserts NO membership through the proxy too", async () => {
    const { runtime, store, seed } = await setup();
    await seed("app_org_nomember", "acme");
    await seedGrantRows(store, "app_org_nomember", { "user:kim": "viewer" });

    const opened = await runtime.open("app_org_nomember", ctx("kim"));
    expect(opened).toEqual({
      kind: "http",
      url: "/api/vendo/apps/app_org_nomember/serve/",
    });
    expect((opened as { url: string }).url).not.toMatch(/^https?:\/\//);
  });

  /** The owner's OWN app used to keep the provider's raw ingress URL, on the
      reasoning that a capability URL is fine for the person who owns the thing.
      It is not: that URL carries no per-request check, so anyone it is pasted to
      — a shared screen, a copied link, a log line, a bug report — reaches the
      box. Every served app is answered with this deployment's proxy now, which
      re-checks `can(viewer)` against live rows on every request. */
  it("routes a PERSONAL served app through the proxy too — an owner's own app is not a bearer URL", async () => {
    const { runtime, store, seed } = await setup();
    await seed("app_own_served", "dana");

    const opened = await runtime.open("app_own_served", ctx("dana"));
    expect(opened).toEqual({
      kind: "http",
      url: "/api/vendo/apps/app_own_served/serve/",
    });
    // And specifically NOT the sandbox provider's public ingress URL.
    expect((opened as { url: string }).url).not.toMatch(/^https?:\/\//);
    // The owner's own app is reachable through that very door.
    expect((await runtime.serve("app_own_served", { method: "GET", path: "/" }, ctx("dana"))).status).toBe(200);
    // A stranger with no grant is not, on the same door.
    await expect(runtime.serve("app_own_served", { method: "GET", path: "/" }, ctx("mal")))
      .rejects.toMatchObject({ code: "not-found" });
  });
});

describe("§9.8 — editing a served app is a permission question first", () => {
  /** `edit()` on a served app carried the served flag's refusal in front of
      everything else. With the flag gone, the refusal that must still come
      first is PERMISSION: a viewer hears "you can't change the team's copy" —
      the sentence the fork offer renders from — and no in-box agent is ever
      woken on their behalf. */
  it("refuses a VIEWER's edit before any machine is touched", async () => {
    const { runtime, store, seed, sandbox } = await setup();
    await seed("app_viewer_edit", "acme");
    await seedGrantRows(store, "app_viewer_edit", { "user:kim": "viewer" });
    const before = sandbox.machines.length;

    await expect(runtime.edit("app_viewer_edit", "make the header blue", ctx("kim", ["acme"])))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(sandbox.machines.length).toBe(before);
  });
});

describe("§9.8 — serve() checks can(viewer) against live rows, every request", () => {
  const GET: BoxRequest = { method: "GET", path: "/" };

  it("serves a granted viewer and refuses a stranger", async () => {
    const { runtime, store, seed } = await setup();
    await seed("app_serve", "acme");
    await seedGrantRows(store, "app_serve", { "user:kim": "viewer" });

    expect((await runtime.serve("app_serve", GET, ctx("kim", ["acme"]))).status).toBe(200);
    await expect(runtime.serve("app_serve", GET, ctx("mal", ["acme"])))
      .rejects.toMatchObject({ code: "not-found" });
  });

  // The red half of the gate: a mid-session revoke bites the NEXT request.
  it("refuses the next request after the viewer's grant is revoked", async () => {
    const { runtime, store, seed } = await setup();
    await seed("app_revoke_serve", "acme");
    await seedGrantRows(store, "app_revoke_serve", { "user:kim": "viewer" });
    const kim = ctx("kim", ["acme"]);
    expect((await runtime.serve("app_revoke_serve", GET, kim)).status).toBe(200);

    // The owner takes the grant away; nothing about kim's session changes.
    const admin: RunContext = { ...ctx("dana"), memberships: [{ org: "acme", admin: true }] };
    await runtime.access.revoke("app_revoke_serve", "user:kim", admin);

    await expect(runtime.serve("app_revoke_serve", GET, kim))
      .rejects.toMatchObject({ code: "not-found" });
  });

  it("forwards the PAYLOAD only — no cookie, authorization, or host header crosses", async () => {
    const { runtime, store, seed, sandbox } = await setup();
    await seed("app_payload", "acme");
    await seedGrantRows(store, "app_payload", { "user:kim": "viewer" });

    await runtime.serve("app_payload", {
      method: "POST",
      path: "/checkout",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode('{"ok":true}'),
    }, ctx("kim", ["acme"]));

    // Read what actually crossed the skin, not what we hoped we sent.
    const crossed = sandbox.machines.flatMap((machine) => machine.received)
      .filter((entry) => entry.path === "/checkout");
    expect(crossed).toHaveLength(1);
    expect(Object.keys(crossed[0]!.headers).map((name) => name.toLowerCase()).sort())
      .toEqual(["content-type"]);
  });

  /** An egress approval is self-subject like every other approval, but its
      EFFECT is not: a decision writes `egressApproved` onto the SHARED app
      document and binds everyone who uses the app afterwards. So the ask
      belongs to a caller who can change the app — which is what
      `EgressApprovalRequest.owner` has always claimed it records ("the app
      owner's principal subject — the only principal who may approve"). The
      §9.8 served door runs at VIEWER level, and it parked a card recorded as
      the viewer. */
  it("never lets a VIEWER decide the app's egress, and parks no card in their name", async () => {
    const { runtime, store, seed, guard, sandbox } = await setup();
    await seed("app_viewer_egress", "acme", ["api.stripe.com"]);
    await seedGrantRows(store, "app_viewer_egress", { "user:kim": "viewer" });
    const before = sandbox.machines.length;

    await expect(runtime.serve("app_viewer_egress", GET, ctx("kim", ["acme"])))
      .rejects.toMatchObject({ code: "blocked" });

    expect(guard.approvals).toHaveLength(0);
    expect((await store.records("vendo_egress_approval").list({})).records).toEqual([]);
    // And it costs no machine, for the same reason the access check comes first.
    expect(sandbox.machines.length).toBe(before);
  });

  it("still asks the person who CAN change the app", async () => {
    const { runtime, store, seed, guard } = await setup();
    await seed("app_editor_egress", "acme", ["api.stripe.com"]);
    await seedGrantRows(store, "app_editor_egress", { "user:rae": "editor" });

    await expect(runtime.serve("app_editor_egress", GET, ctx("rae", ["acme"])))
      .rejects.toMatchObject({ code: "blocked" });
    expect(guard.approvals).toHaveLength(1);
    expect(guard.approvals[0]?.ctx.principal.subject).toBe("rae");
  });

  it("wakes the machine only AFTER the access check, never before", async () => {
    // A refused caller must not cost a machine: the check comes first, so a
    // stranger hammering the proxy cannot spin up someone else's box.
    const { runtime, seed, sandbox } = await setup();
    await seed("app_no_wake", "acme");
    const before = sandbox.machines.length;
    await expect(runtime.serve("app_no_wake", GET, ctx("mal", ["acme"])))
      .rejects.toMatchObject({ code: "not-found" });
    expect(sandbox.machines.length).toBe(before);
  });
});
