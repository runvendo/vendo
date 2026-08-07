import {
  VENDO_APP_FORMAT,
  VendoError,
  type AccessLevel,
  type AppAccess,
  type AppDocument,
  type AppId,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { appAccessConformance } from "@vendoai/core/conformance";
import { describe, expect, it } from "vitest";
import { createApps, type AppsConfig, type AppsRuntime } from "./index.js";
import {
  basicLanguageModel,
  guardFixture,
  memoryStore,
  scriptedAssembler,
  seedAppRow,
} from "./testing/index.js";
// One copy of the AppAccess stand-in, shared with served-orgs.test.ts.
import { seedGrantRows as seedGrants, storeAccessFixture as storeAccess } from "./testing/app-access-fixture.js";

/** Build contract §9.3–§9.6 — the apps runtime is level-aware through ONE
    `can()`; the wire and the MCP door inherit it rather than re-deriving it. */

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no fixture tools" } }; },
};

const doc = (id: string, name = "Dash"): AppDocument => ({ format: VENDO_APP_FORMAT, id, name });

const ctx = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `s_${subject}`,
});

/** The ONE engine, scripted: it answers every ask whole and names the app after
 *  what was said, so a create and an edit both land through the real `authored`
 *  persist path. Same fixture shape as lifecycle.test.ts. */
const screenFor = (runtime: () => AppsRuntime) =>
  scriptedAssembler(runtime, ({ request }) => {
    // An EDIT's brief leads with the app's memory block, so the ask is its last line.
    const line = request.split("\n").map((part) => part.trim()).filter((part) => part !== "").at(-1) ?? "";
    const said = line.slice(0, 40).replaceAll('"', "'") || "Untitled app";
    return `<App name="${said}"><Text text="${said}"/><Disclaimer reason="Scripted fixture app."/></App>`;
  });

const setup = (
  over: Partial<AppsConfig> = {},
): { runtime: AppsRuntime; store: ReturnType<typeof memoryStore> } => {
  const store = memoryStore();
  let runtime: AppsRuntime;
  runtime = createApps({
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    screen: screenFor(() => runtime),
    appAccess: storeAccess(store),
    multiParty: true,
    // The umbrella fills this with `appStore().promote` + the workspace move
    // (both raw-row work only the store can do, proven in @vendoai/store's own
    // promote suite); here it is the same subject flip through the door.
    promoteApp: async (appId, _from, orgId) => {
      const record = await store.records("vendo_apps").get(appId);
      if (record === null) return;
      await store.records("vendo_apps").delete(appId);
      await store.records("vendo_apps").put({
        id: appId,
        data: { ...record.data as object, subject: orgId },
        refs: { subject: orgId },
      });
    },
    ...over,
  });
  return { runtime, store };
};

// The SHARED rule (core's conformance kit), mounted against the stand-in these
// tests run on. @vendoai/store mounts the SAME cases against the real
// `appAccess(store)`, so the two implementations cannot drift: mutating either
// one fails here. Without this, mutating the real `can()` to `return true` left
// this suite green.
describe("core's app-access conformance kit, over the runtime's stand-in", () => {
  const store = memoryStore();
  const suite = appAccessConformance({
    access: storeAccess(store),
    seedApp: (appId, subject) => seedAppRow(store, doc(appId), subject).then(() => undefined),
    seedGrant: async (appId, principal, level) => {
      await store.records("vendo_app_grants").put({
        id: `ag_${appId}_${principal}`,
        data: { appId, orgId: "conformance-org", principal, level, createdBy: "seed" },
        refs: { app_id: appId, principal, level },
      });
    },
  });
  for (const conformanceCase of suite.cases) it(conformanceCase.name, conformanceCase.run);
});

describe("§9.3 — reads need viewer, edits editor, delete owner", () => {
  it("serves a granted viewer the app and masks it from everyone else", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_shared"), "acme");
    await seedGrants(store, "app_shared", { "user:kim": "viewer" });

    expect((await runtime.get("app_shared", ctx("kim")))?.id).toBe("app_shared");
    // Existence-masking survives for a non-viewer (§9.4).
    expect(await runtime.get("app_shared", ctx("mal"))).toBeNull();
  });

  it("gives a viewer `forbidden` on an edit and a stranger `not-found`", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_edit"), "acme");
    await seedGrants(store, "app_edit", { "user:kim": "viewer" });

    await expect(runtime.edit("app_edit", "make it blue", ctx("kim")))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(runtime.edit("app_edit", "make it blue", ctx("mal")))
      .rejects.toMatchObject({ code: "not-found" });
  });

  it("reserves delete for an owner", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_del"), "acme");
    await seedGrants(store, "app_del", { "user:kim": "editor", "user:dana": "owner" });

    await expect(runtime.delete("app_del", ctx("kim")))
      .rejects.toMatchObject({ code: "forbidden" });
    await runtime.delete("app_del", ctx("dana"));
    expect(await runtime.get("app_del", ctx("dana"))).toBeNull();
  });

  it("keeps ownership working with no appAccess wired at all (OSS default)", async () => {
    const { runtime, store } = setup({ appAccess: undefined, multiParty: undefined });
    await seedAppRow(store, doc("app_solo"), "dana");
    expect((await runtime.get("app_solo", ctx("dana")))?.id).toBe("app_solo");
    expect(await runtime.get("app_solo", ctx("kim"))).toBeNull();
  });

  it("lets an org admin edit an org app with no grant row at all", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_admin"), "acme");
    const admin: RunContext = { ...ctx("dana"), memberships: [{ org: "acme", admin: true }] };
    const member: RunContext = { ...ctx("kim"), memberships: [{ org: "acme" }] };
    expect((await runtime.get("app_admin", admin))?.id).toBe("app_admin");
    // Membership alone is not access.
    expect(await runtime.get("app_admin", member)).toBeNull();
  });
});

describe("§9.3 — history is level-aware in the RUNTIME, not only at the wire", () => {
  it("keeps list at viewer, reserves undo for an editor, masks a stranger", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_hist"), "acme");
    await seedGrants(store, "app_hist", { "user:kim": "viewer", "user:dana": "editor" });

    // A viewer may read the version list...
    expect(await runtime.history("app_hist", ctx("kim")).list()).toEqual([]);
    // ...but rolling the team's app back is an edit.
    await expect(runtime.history("app_hist", ctx("kim")).undo())
      .rejects.toMatchObject({ code: "forbidden" });
    // A caller who cannot see it at all stays masked at both verbs.
    await expect(runtime.history("app_hist", ctx("mal")).list())
      .rejects.toMatchObject({ code: "not-found" });
    await expect(runtime.history("app_hist", ctx("mal")).undo())
      .rejects.toMatchObject({ code: "not-found" });
  });
});

describe("§9.3 — list unions owned and granted", () => {
  it("lists the caller's own apps plus every app they hold a grant on", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_org", "Team dash"), "acme");
    await seedAppRow(store, doc("app_team", "Finance dash"), "acme");
    await seedAppRow(store, doc("app_mine", "My dash"), "kim");
    await seedAppRow(store, doc("app_hidden", "Not yours"), "mal");
    await seedGrants(store, "app_org", { "user:kim": "viewer" });
    await seedGrants(store, "app_team", { "team:acme/finance": "editor" });

    const kim: RunContext = { ...ctx("kim"), memberships: [{ org: "acme", teams: ["finance"] }] };
    expect((await runtime.list(kim)).map((app) => app.id).sort())
      .toEqual(["app_mine", "app_org", "app_team"]);

    // A team the host did NOT assert this request simply does not match.
    expect((await runtime.list(ctx("kim"))).map((app) => app.id).sort())
      .toEqual(["app_mine", "app_org"]);
  });
});

describe("§9.5 — fork needs viewer, and grants never travel", () => {
  it("lets a viewer fork into their own workspace with no grants attached", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_src"), "acme");
    await seedGrants(store, "app_src", { "user:kim": "viewer" });

    const fork = await runtime.fork("app_src", ctx("kim"));
    expect(fork.forkedFrom).toBe("app_src");
    expect(fork.id).not.toBe("app_src");
    // Structural: a fresh id in the forker's own collection, so no grant row
    // can possibly point at it.
    const carried = await store.records("vendo_app_grants").list({ refs: { app_id: fork.id } });
    expect(carried.records).toEqual([]);
    expect((await store.records("vendo_apps").get(fork.id))?.refs?.["subject"]).toBe("kim");
    // ...and the fork is the forker's own: they can edit what they could only view.
    expect(await runtime.access.levelFor(fork.id, ctx("kim"))).toBe("owner");
  });

  it("refuses a fork to someone who cannot see the app", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_src2"), "acme");
    await expect(runtime.fork("app_src2", ctx("mal")))
      .rejects.toMatchObject({ code: "not-found" });
  });
});

describe("§9.5–§9.6 — promote", () => {
  it("moves the row subject to the org verbatim and grants the promoter owner", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_promote"), "dana");
    const withOrg: RunContext = { ...ctx("dana"), memberships: [{ org: "acme" }] };

    await runtime.promote("app_promote", "acme", withOrg);

    expect((await store.records("vendo_apps").get("app_promote"))?.refs?.["subject"]).toBe("acme");
    expect(await runtime.access.levelFor("app_promote", withOrg)).toBe("owner");
    // The promoter still reaches it after promotion — through the grant, not
    // through ownership of the row (which is the org's now).
    expect(await runtime.access.levelFor("app_promote", ctx("dana"))).toBe("owner");
  });

  it("keeps an org app editable by its editors after promotion", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_promoted_edit"), "dana");
    const dana: RunContext = { ...ctx("dana"), memberships: [{ org: "acme" }] };
    await runtime.promote("app_promoted_edit", "acme", dana);
    await runtime.access.grant("app_promoted_edit", "user:kim", "editor", dana);
    // An org-owned row is pinned WHERE id AND subject: the write must carry the
    // ORG as the row subject, not the editor, or it silently lands nowhere.
    await runtime.schedule("app_promoted_edit", "0 9 * * *", ctx("kim")).catch(() => undefined);
    expect((await store.records("vendo_apps").get("app_promoted_edit"))?.refs?.["subject"]).toBe("acme");
  });

  it("DISARMS an enabled automation, because automations run with a person's access", async () => {
    // There is no org principal to run as: the sponsor is a person who may not
    // even be in the team. Leaving it armed would run it as a synthetic user
    // named after the org — no connections, no secrets, audit attributed to
    // nobody. Re-enabling later mints a fresh sponsorship under a real person.
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_armed"), "dana", true);
    const withOrg: RunContext = { ...ctx("dana"), memberships: [{ org: "acme" }] };

    await runtime.promote("app_armed", "acme", withOrg);

    const row = await store.records("vendo_apps").get("app_armed");
    expect((row?.data as { enabled: boolean }).enabled).toBe(false);
    // The document itself is untouched — only the arming bit moved.
    expect((row?.data as { doc: AppDocument }).doc.name).toBe("Dash");
  });

  it("leaves an app that was already off exactly as it was", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_unarmed"), "dana", false);
    await runtime.promote("app_unarmed", "acme", { ...ctx("dana"), memberships: [{ org: "acme" }] });
    const row = await store.records("vendo_apps").get("app_unarmed");
    expect((row?.data as { enabled: boolean }).enabled).toBe(false);
  });

  it("restores the promoter's PREVIOUS level when the move fails, never deleting the grant", async () => {
    // "Undo only what THIS call did" has two halves, and this is the one no
    // integration test reaches: the promoter already held a grant, so a failed
    // promote must put that level back rather than take the grant away. Reading
    // the level AFTER the mint cannot tell "I made this" from "it was already
    // here", which is why `heldBefore` is read first.
    const { runtime, store } = setup({
      promoteApp: async () => { throw new VendoError("conflict", "the move refused"); },
    });
    await seedAppRow(store, doc("app_prior_level"), "dana");
    await seedGrants(store, "app_prior_level", { "user:dana": "viewer" });

    await expect(runtime.promote("app_prior_level", "acme", { ...ctx("dana"), memberships: [{ org: "acme" }] }))
      .rejects.toMatchObject({ code: "conflict" });

    const rows = await store.records("vendo_app_grants").list({ refs: { app_id: "app_prior_level" } });
    expect(rows.records).toHaveLength(1);
    expect((rows.records[0]?.data as { level: AccessLevel }).level).toBe("viewer");
  });

  it("keeps the grant when another promote flipped the row before this one failed", async () => {
    // The lost race, at the runtime level: the row no longer names `from`, so
    // the grant now admits the promoter to the app that just moved. Revoking it
    // would lock her out of her own app — the round-2 blocker.
    const { runtime, store } = setup({
      promoteApp: async (appId, _from, orgId) => {
        // The winner's flip, exactly as the store's own door does it (rows never
        // cross subjects, so the row is replaced, not updated in place)...
        const record = await store.records("vendo_apps").get(appId);
        await store.records("vendo_apps").delete(appId);
        await store.records("vendo_apps").put({
          id: appId,
          data: { ...record?.data as object, subject: orgId },
          refs: { subject: orgId },
        });
        // ...and then THIS call's own flip losing to it.
        throw new VendoError("conflict", `app ${appId} belongs to another subject`);
      },
    });
    await seedAppRow(store, doc("app_lost_race"), "dana");

    await expect(runtime.promote("app_lost_race", "acme", { ...ctx("dana"), memberships: [{ org: "acme" }] }))
      .rejects.toMatchObject({ code: "conflict" });

    const rows = await store.records("vendo_app_grants").list({ refs: { app_id: "app_lost_race" } });
    expect(rows.records.map((row) => (row.data as { principal: string }).principal)).toEqual(["user:dana"]);
    // ...and she still reaches the app the winner moved.
    expect(await runtime.access.levelFor("app_lost_race", ctx("dana"))).toBe("owner");
  });

  it("requires an asserted membership in the target org", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_promote2"), "dana");
    await expect(runtime.promote("app_promote2", "acme", ctx("dana")))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("requires ownership of the app", async () => {
    const { runtime, store } = setup();
    await seedAppRow(store, doc("app_promote3"), "dana");
    await seedGrants(store, "app_promote3", { "user:kim": "editor" });
    const kim: RunContext = { ...ctx("kim"), memberships: [{ org: "acme" }] };
    await expect(runtime.promote("app_promote3", "acme", kim))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses when no store-backed promote seam is wired", async () => {
    const { runtime, store } = setup({ promoteApp: undefined });
    await seedAppRow(store, doc("app_promote4"), "dana");
    await expect(runtime.promote("app_promote4", "acme", { ...ctx("dana"), memberships: [{ org: "acme" }] }))
      .rejects.toMatchObject({ code: "cloud-required" });
  });
});

describe("§9.6 — cloud gating", () => {
  it("refuses grant, revoke, and promote with no key", async () => {
    const { runtime, store } = setup({ multiParty: false });
    await seedAppRow(store, doc("app_gate"), "dana");
    const withOrg: RunContext = { ...ctx("dana"), memberships: [{ org: "acme" }] };

    await expect(runtime.access.grant("app_gate", "user:kim", "viewer", ctx("dana")))
      .rejects.toMatchObject({ code: "cloud-required" });
    await expect(runtime.access.revoke("app_gate", "user:kim", ctx("dana")))
      .rejects.toMatchObject({ code: "cloud-required" });
    await expect(runtime.promote("app_gate", "acme", withOrg))
      .rejects.toMatchObject({ code: "cloud-required" });
  });

  it("still ENFORCES can() with no key — reading the grant list is OSS", async () => {
    const { runtime, store } = setup({ multiParty: false });
    await seedAppRow(store, doc("app_gate2"), "acme");
    await seedGrants(store, "app_gate2", { "user:kim": "viewer" });
    expect((await runtime.get("app_gate2", ctx("kim")))?.id).toBe("app_gate2");
    expect(await runtime.access.list("app_gate2", ctx("kim"))).toHaveLength(1);
  });

  it("answers the grant LIST from an unwired seam the way levelFor already does — never 402 on a read", async () => {
    // `levelFor` degenerates to ownership when no app-access seam is wired (the
    // OSS single-player default); `list` threw `cloud-required` from the same
    // absence, so the Share dialog's FIRST READ 402'd on every keyless
    // deployment and the two doors disagreed about the same fact.
    const { runtime, store } = setup({ appAccess: undefined, multiParty: false });
    await seedAppRow(store, doc("app_noseam"), "dana");
    expect(await runtime.access.levelFor("app_noseam", ctx("dana"))).toBe("owner");
    // With no seam no grant row can exist (§9.6), so the empty list is the
    // honest answer — and it stays viewer-gated.
    expect(await runtime.access.list("app_noseam", ctx("dana"))).toEqual([]);
    await expect(runtime.access.list("app_noseam", ctx("mal")))
      .rejects.toMatchObject({ code: "not-found" });
  });

  // The green half: with a key the same three writes go through.
  it("allows them once the key filled the seam", async () => {
    const { runtime, store } = setup();
    // Held by the ORG: sharing implies the org workspace, so a live person
    // grant only exists on an app that has already moved there.
    await seedAppRow(store, doc("app_keyed"), "acme");
    const admin: RunContext = { ...ctx("dana"), memberships: [{ org: "acme", admin: true }] };
    await runtime.access.grant("app_keyed", "user:kim", "editor", admin);
    expect(await runtime.access.list("app_keyed", admin)).toHaveLength(1);
    expect(await runtime.access.levelFor("app_keyed", ctx("kim"))).toBe("editor");
    await runtime.access.revoke("app_keyed", "user:kim", admin);
    expect(await runtime.access.list("app_keyed", admin)).toHaveLength(0);
    expect(await runtime.access.levelFor("app_keyed", ctx("kim"))).toBeNull();
  });
});

describe("§9.9 — the onDocumentEdit choke point", () => {
  /**
   * Lane H's OWN rule, so these cases assert the consequence the hook exists for
   * rather than merely that a function got called: a sponsorship survives its
   * sponsor's own changes and dies on anybody else's.
   *
   * The previous version of the first case asserted `seen.every(...)` over an
   * array that stayed EMPTY — both writes it drove threw and were swallowed by
   * `.catch(() => undefined)` — so it could not fail. `toHaveLength` is the
   * whole difference between a test and a decoration.
   */
  const sponsoredBy = (sponsor: string): {
    state: { active: boolean; edits: Array<{ from: string; to: string; editor: string }> };
    onDocumentEdit: NonNullable<AppsConfig["onDocumentEdit"]>;
  } => {
    const state = { active: true, edits: [] as Array<{ from: string; to: string; editor: string }> };
    return {
      state,
      onDocumentEdit: async (previous, next, editor) => {
        state.edits.push({ from: previous.name ?? "", to: next.name ?? "", editor });
        if (editor !== sponsor) state.active = false;
      },
    };
  };

  it("rings once per landed edit, with previous, next, and the editor", async () => {
    const { state, onDocumentEdit } = sponsoredBy("dana");
    const { runtime } = setup({ onDocumentEdit, model: basicLanguageModel() });
    const app = await runtime.create({ prompt: "Before" }, ctx("dana"));
    await runtime.edit(app.id, "After", ctx("dana"));

    expect(state.edits).toHaveLength(1);
    expect(state.edits[0]).toMatchObject({ from: "Before", to: "After", editor: "dana" });
    // The sponsor changing their own app is not a third-party edit.
    expect(state.active).toBe(true);
  });

  it("treats an UNDO as an edit: a third party's rollback invalidates the sponsorship", async () => {
    // §9.9 calls persistEdit "the ONE choke point every document edit passes
    // through", and undo wrote the app row directly — so rolling the team's app
    // back was the one way to change what an app IS without the sponsorship
    // hearing about it. Silently skipping the invalidation lane H exists for.
    const { state, onDocumentEdit } = sponsoredBy("dana");
    const { runtime, store } = setup({ onDocumentEdit, model: basicLanguageModel() });
    const app = await runtime.create({ prompt: "Before" }, ctx("dana"));
    await runtime.edit(app.id, "After", ctx("dana"));
    expect(state.active).toBe(true);

    await seedGrants(store, app.id, { "user:kim": "editor" });
    const restored = await runtime.history(app.id, ctx("kim")).undo();

    expect(restored.name).toBe("Before");
    expect(state.edits.at(-1)).toMatchObject({ from: "After", to: "Before", editor: "kim" });
    expect(state.active).toBe(false);
  });

  it("leaves the sponsorship alone when the SPONSOR rolls their own app back", async () => {
    const { state, onDocumentEdit } = sponsoredBy("dana");
    const { runtime } = setup({ onDocumentEdit, model: basicLanguageModel() });
    const app = await runtime.create({ prompt: "Before" }, ctx("dana"));
    await runtime.edit(app.id, "After", ctx("dana"));

    await runtime.history(app.id, ctx("dana")).undo();
    expect(state.edits.at(-1)).toMatchObject({ editor: "dana" });
    expect(state.active).toBe(true);
  });
});

describe("§9.9 — the additive, ctx-aware venue-state slot", () => {
  it("merges a per-caller state into the open payload beside the in-client verdict", async () => {
    const seen: string[] = [];
    const { runtime, store } = setup({
      venueState: async (app, runCtx) => {
        seen.push(`${app.id}:${runCtx.principal.subject}`);
        // Lane H's adoption card is served only to editors — the whole reason
        // this slot takes the ctx.
        return await runtime.access.levelFor(app.id, runCtx) === "viewer"
          ? undefined
          : { adoption: { automation: "nightly digest" } };
      },
    });
    const app: AppDocument = {
      ...doc("app_venue"),
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v2",
        root: "root",
        nodes: [{ id: "root", component: "Stack", source: "prewired" }],
      },
    };
    await seedAppRow(store, app, "acme");
    await seedGrants(store, "app_venue", { "user:kim": "viewer", "user:dana": "editor" });

    const editorView = await runtime.open("app_venue", ctx("dana"));
    expect(editorView).toMatchObject({ kind: "tree" });
    expect((editorView as { payload: Record<string, unknown> }).payload["adoption"])
      .toEqual({ automation: "nightly digest" });

    const viewerView = await runtime.open("app_venue", ctx("kim"));
    expect((viewerView as { payload: Record<string, unknown> }).payload["adoption"]).toBeUndefined();
    expect(seen).toEqual(["app_venue:dana", "app_venue:kim"]);
  });
});

describe("§9.3 — the MCP door inherits can() rather than re-deriving it", () => {
  it("gates the door's whole surface (list · open · call) through the runtime", async () => {
    // 10-mcp §4's AppsPort is a structural SUBSET of AppsRuntime — the umbrella
    // passes these three verbs essentially verbatim (server.ts's `appsPort`), so
    // there is no second permission path to police. This exercises exactly that
    // triple at viewer level and for a stranger.
    const { runtime, store } = setup();
    const app: AppDocument = {
      ...doc("app_door"),
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v2",
        root: "root",
        nodes: [{ id: "root", component: "Stack", source: "prewired" }],
      },
    };
    await seedAppRow(store, app, "acme");
    await seedGrants(store, "app_door", { "user:kim": "viewer" });

    const port = {
      list: (runCtx: RunContext) => runtime.list(runCtx),
      open: (id: AppId, runCtx: RunContext) => runtime.open(id, runCtx),
      call: (id: AppId, ref: string, runCtx: RunContext) => runtime.call(id, ref, {}, runCtx),
    };

    // A viewer reaches all three (viewer = see + use).
    expect((await port.list(ctx("kim"))).map((entry) => entry.id)).toEqual(["app_door"]);
    expect(await port.open("app_door", ctx("kim"))).toMatchObject({ kind: "tree" });
    // `call` resolves through the guard-bound registry; what matters here is
    // that the PERMISSION gate let it through rather than masking the app.
    await expect(port.call("app_door", "host_missing", ctx("kim")))
      .resolves.toMatchObject({ status: "error" });

    // A stranger sees nothing and reaches nothing — masked, never 403.
    expect(await port.list(ctx("mal"))).toEqual([]);
    await expect(port.open("app_door", ctx("mal"))).rejects.toMatchObject({ code: "not-found" });
    await expect(port.call("app_door", "host_missing", ctx("mal")))
      .rejects.toMatchObject({ code: "not-found" });
  });
});

describe("§9.3 — the permission check costs what it claims to cost", () => {
  /** Counts app-row reads and `can()` calls through the SAME store the runtime
      and its `can()` both use, so the numbers are the real ones. */
  const instrumented = (over: Partial<AppsConfig> = {}) => {
    const store = memoryStore();
    let rowReads = 0;
    const counting = {
      ...store,
      records: (collection: string) => {
        const records = store.records(collection);
        if (collection !== "vendo_apps") return records;
        return { ...records, get: async (id: string) => { rowReads += 1; return await records.get(id); } };
      },
    } as ReturnType<typeof memoryStore>;
    const real = storeAccess(counting);
    let canCalls = 0;
    const access: AppAccess = { ...real, can: (...args) => { canCalls += 1; return real.can(...args); } };
    const runtime = createApps({
      store: counting,
      guard: guardFixture(),
      tools,
      catalog: [],
      appAccess: access,
      multiParty: true,
      ...over,
    });
    return {
      runtime,
      store,
      reset: () => { rowReads = 0; canCalls = 0; },
      rowReads: () => rowReads,
      canCalls: () => canCalls,
    };
  };

  it("keeps an owner's get() at ONE app-row read even with can() wired", async () => {
    // open() and get() are on every render. The row `owned()` just read answers
    // the whole question for its owner — ownership IS the top level — so the
    // grants query and the second read must not happen.
    const { runtime, store, reset, rowReads } = instrumented();
    await seedAppRow(store, doc("app_one_read"), "dana");
    reset();
    expect((await runtime.get("app_one_read", ctx("dana")))?.id).toBe("app_one_read");
    expect(rowReads()).toBe(1);
  });

  it("still consults can() for a caller who is NOT the row's subject", async () => {
    const { runtime, store, reset, canCalls } = instrumented();
    await seedAppRow(store, doc("app_not_mine"), "acme");
    await seedGrants(store, "app_not_mine", { "user:kim": "viewer" });
    reset();
    expect((await runtime.get("app_not_mine", ctx("kim")))?.id).toBe("app_not_mine");
    expect(canCalls()).toBe(1);
  });

  it("checks access ONCE per serve, not twice", async () => {
    const { runtime, store, reset, canCalls } = instrumented();
    await seedAppRow(store, doc("app_serve_once"), "acme");
    await seedGrants(store, "app_serve_once", { "user:kim": "viewer" });
    reset();
    // The machine is absent, so the forward fails — the access check has
    // already happened by then, which is exactly what this counts.
    await runtime.serve("app_serve_once", { method: "GET", path: "/" }, ctx("kim"))
      .catch(() => undefined);
    expect(canCalls()).toBe(1);
  });
});

describe("§9.5 — the hosted-store promote limitation speaks plainly", () => {
  it("names what is unavailable AND the fix, in one consumer-safe sentence", async () => {
    const { runtime, store } = setup({ promoteApp: undefined });
    await seedAppRow(store, doc("app_hosted"), "dana");
    await expect(runtime.promote("app_hosted", "acme", { ...ctx("dana"), memberships: [{ org: "acme" }] }))
      .rejects.toMatchObject({
        code: "cloud-required",
        // Consumer-safe: it says what cannot happen, not which seam is unwired.
        message: "moving an app into a team workspace isn't available on the hosted store yet — "
          + "wire your own Postgres with createVendo({ store: createStore({ url }) }) to move it, "
          + "or share a copy with fork instead",
      });
  });
});

/** §9.1 — an unattended fire asserting the same orgs a request does used to be
 *  proven here, against the machine-app schedule engine's own `memberships`
 *  seam. That engine is gone: a `vendo.json` schedule is a doc trigger now, and
 *  the ONE unattended firing path is the automations engine, whose own
 *  `memberships` seam is proven in
 *  `packages/automations/src/sponsorship.test.ts`. */
