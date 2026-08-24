import { engineOverAdapter } from "@vendoai/core";
import {
  VENDO_APP_FORMAT,
  type AppAccess,
  type AppId,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import {
  type AppDocument,
} from "../src/contract/index.js";
import { appAccessConformance } from "@vendoai/core/conformance";
import { describe, expect, it, vi } from "vitest";
import { createApps, type AppsConfig, type AppsRuntime } from "../src/server/index.js";
import { scriptedAssembler } from "../src/server/testing/screen-assembler.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { basicLanguageModel } from "../src/server/testing/scripted-model.js";
import { screenDocument } from "../src/server/testing/screen-document.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";
// One copy of the AppAccess stand-in, shared with served-orgs.test.ts.
import { seedGrantRows as seedGrants, storeAccessFixture as storeAccess } from "./app-access-fixture.js";

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
 *  what was said — the screen's default export is the app's title — so a create
 *  and an edit both land through the real `authoredScreen` persist path. Same
 *  fixture shape as lifecycle.test.ts. */
const screenFor = (runtime: () => AppsRuntime) =>
  scriptedAssembler(runtime, ({ request }) => {
    // An EDIT's brief leads with the app's memory block, so the ask is its last line.
    const line = request.split("\n").map((part) => part.trim()).filter((part) => part !== "").at(-1) ?? "";
    const words = line.replace(/[^A-Za-z0-9]+/gu, " ").trim().split(" ");
    const said = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("") || "Untitled";
    return `import { Stack, Text } from "@vendo/screen";

export default function ${said}() {
  return (
    <Stack gap={12}>
      <Text text="Ready" variant="heading" />
    </Stack>
  );
}
`;
  });

const setup = (
  over: Partial<AppsConfig> = {},
): { runtime: AppsRuntime; store: ReturnType<typeof memoryStore>; access: AppAccess } => {
  const store = memoryStore();
  // The same seam the runtime is wired with, handed back so a case can write
  // the grant rows a world needs — the runtime has only the READ half.
  const access = storeAccess(store);
  let runtime: AppsRuntime;
  runtime = createApps({
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    screen: screenFor(() => runtime),
    appAccess: access,
    ...over,
  });
  return { runtime, store, access };
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
    seedApp: (appId, subject) => seedAppRow(engineOverAdapter(store), doc(appId), subject).then(() => undefined),
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
    await seedAppRow(engineOverAdapter(store), doc("app_shared"), "acme");
    await seedGrants(store, "app_shared", { "user:kim": "viewer" });

    expect((await runtime.get("app_shared", ctx("kim")))?.id).toBe("app_shared");
    // Existence-masking survives for a non-viewer (§9.4).
    expect(await runtime.get("app_shared", ctx("mal"))).toBeNull();
  });

  it("gives a viewer `forbidden` on an edit and a stranger `not-found`", async () => {
    const { runtime, store } = setup();
    await seedAppRow(engineOverAdapter(store), doc("app_edit"), "acme");
    await seedGrants(store, "app_edit", { "user:kim": "viewer" });

    await expect(runtime.edit("app_edit", "make it blue", ctx("kim")))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(runtime.edit("app_edit", "make it blue", ctx("mal")))
      .rejects.toMatchObject({ code: "not-found" });
  });

  it("reserves delete for an owner", async () => {
    const { runtime, store } = setup();
    await seedAppRow(engineOverAdapter(store), doc("app_del"), "acme");
    await seedGrants(store, "app_del", { "user:kim": "editor", "user:dana": "owner" });

    await expect(runtime.delete("app_del", ctx("kim")))
      .rejects.toMatchObject({ code: "forbidden" });
    await runtime.delete("app_del", ctx("dana"));
    expect(await runtime.get("app_del", ctx("dana"))).toBeNull();
  });

  it("keeps ownership working with no appAccess wired at all (OSS default)", async () => {
    const { runtime, store } = setup({ appAccess: undefined });
    await seedAppRow(engineOverAdapter(store), doc("app_solo"), "dana");
    expect((await runtime.get("app_solo", ctx("dana")))?.id).toBe("app_solo");
    expect(await runtime.get("app_solo", ctx("kim"))).toBeNull();
    // `levelFor` answers from the same absence rather than failing the read:
    // with no seam no grant row can exist, so ownership is the only level.
    expect(await runtime.access.levelFor("app_solo", ctx("dana"))).toBe("owner");
    expect(await runtime.access.levelFor("app_solo", ctx("kim"))).toBeNull();
  });

  it("lets an org admin edit an org app with no grant row at all", async () => {
    const { runtime, store } = setup();
    await seedAppRow(engineOverAdapter(store), doc("app_admin"), "acme");
    const admin: RunContext = { ...ctx("dana"), memberships: [{ org: "acme", admin: true }] };
    const member: RunContext = { ...ctx("kim"), memberships: [{ org: "acme" }] };
    expect((await runtime.get("app_admin", admin))?.id).toBe("app_admin");
    // Membership alone is not access.
    expect(await runtime.get("app_admin", member)).toBeNull();
  });
});

describe("§9.3 — history is level-aware in the RUNTIME, not only at the wire", () => {
  it("keeps list at viewer and masks a stranger", async () => {
    const { runtime, store } = setup();
    await seedAppRow(engineOverAdapter(store), doc("app_hist"), "acme");
    await seedGrants(store, "app_hist", { "user:kim": "viewer", "user:dana": "editor" });

    // A viewer may read the version list...
    expect(await runtime.history("app_hist", ctx("kim")).list()).toEqual([]);
    // ...and a caller who cannot see the app at all stays masked.
    await expect(runtime.history("app_hist", ctx("mal")).list())
      .rejects.toMatchObject({ code: "not-found" });
  });
});

describe("§9.3 — list unions owned and granted", () => {
  it("lists the caller's own apps plus every app they hold a grant on", async () => {
    const { runtime, store } = setup();
    await seedAppRow(engineOverAdapter(store), doc("app_org", "Team dash"), "acme");
    await seedAppRow(engineOverAdapter(store), doc("app_team", "Finance dash"), "acme");
    await seedAppRow(engineOverAdapter(store), doc("app_mine", "My dash"), "kim");
    await seedAppRow(engineOverAdapter(store), doc("app_hidden", "Not yours"), "mal");
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
    await seedAppRow(engineOverAdapter(store), doc("app_src"), "acme");
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
    await seedAppRow(engineOverAdapter(store), doc("app_src2"), "acme");
    await expect(runtime.fork("app_src2", ctx("mal")))
      .rejects.toMatchObject({ code: "not-found" });
  });
});

describe("§9.3 — levelFor answers from LIVE grant rows", () => {
  it("reflects a grant the moment it is written, and its revoke", async () => {
    const { runtime, store, access } = setup();
    // Held by the ORG: sharing implies the org workspace, so a live person
    // grant only exists on an app that has already moved there.
    await seedAppRow(engineOverAdapter(store), doc("app_keyed"), "acme");
    const admin: RunContext = { ...ctx("dana"), memberships: [{ org: "acme", admin: true }] };

    await access.grant(admin, "app_keyed", "user:kim", "editor");
    expect(await runtime.access.levelFor("app_keyed", ctx("kim"))).toBe("editor");

    await access.revoke(admin, "app_keyed", "user:kim");
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
    const app = screenDocument("app_venue");
    await seedAppRow(engineOverAdapter(store), app, "acme");
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
    // 10-mcp §4's apps ride-along is a structural SUBSET of AppsRuntime — the umbrella
    // passes these three verbs essentially verbatim (server.ts's `appsPort`), so
    // there is no second permission path to police. This exercises exactly that
    // triple at viewer level and for a stranger.
    const { runtime, store } = setup();
    const app = screenDocument("app_door");
    await seedAppRow(engineOverAdapter(store), app, "acme");
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
    await seedAppRow(engineOverAdapter(store), doc("app_one_read"), "dana");
    reset();
    expect((await runtime.get("app_one_read", ctx("dana")))?.id).toBe("app_one_read");
    expect(rowReads()).toBe(1);
  });

  it("still consults can() for a caller who is NOT the row's subject", async () => {
    const { runtime, store, reset, canCalls } = instrumented();
    await seedAppRow(engineOverAdapter(store), doc("app_not_mine"), "acme");
    await seedGrants(store, "app_not_mine", { "user:kim": "viewer" });
    reset();
    expect((await runtime.get("app_not_mine", ctx("kim")))?.id).toBe("app_not_mine");
    expect(canCalls()).toBe(1);
  });

});

/** §9.1 — an unattended fire asserting the same orgs a request does used to be
 *  proven here, against the machine-app schedule engine's own `memberships`
 *  seam. That engine is gone: a `vendo.json` schedule is a doc trigger now, and
 *  the ONE unattended firing path is the automations engine, whose own
 *  `memberships` seam is proven in
 *  `packages/automations/src/sponsorship.test.ts`. */

/** Build contract §9.2 — the grant write half, back for the ✦ toggle and
    nothing else. `list` is viewer-gated; grant/revoke are owner-gated, and the
    RUNTIME owns the level so the wire never re-derives it. */
describe("§9.2 — the grant write surface", () => {
  /** The app is held by the ORG, because sharing implies the org workspace —
      core's app-access conformance kit refuses an org grant on a still-personal
      app, and `promote` is not part of this restore. Alice administers acme, so
      she is its owner without a grant row of her own. */
  const shared = async (): Promise<{ runtime: AppsRuntime; access: AppAccess; alice: RunContext }> => {
    const { runtime, store, access } = setup();
    await seedAppRow(engineOverAdapter(store), doc("app_share"), "acme");
    return { runtime, access, alice: { ...ctx("alice"), memberships: [{ org: "acme", admin: true }] } };
  };
  const bob: RunContext = { ...ctx("bob"), memberships: [{ org: "acme" }] };

  it("an owner grants an org at viewer level and reads it back", async () => {
    const { runtime, alice } = await shared();
    const granted = await runtime.access.grant("app_share", "org:acme", "viewer", alice);
    expect(granted).toEqual([expect.objectContaining({ principal: "org:acme", level: "viewer" })]);
    expect(await runtime.access.list("app_share", alice)).toHaveLength(1);
  });

  it("a member of that org can now see the app, and can list its grants", async () => {
    const { runtime, alice } = await shared();
    await runtime.access.grant("app_share", "org:acme", "viewer", alice);
    expect(await runtime.access.levelFor("app_share", bob)).toBe("viewer");
    expect(await runtime.access.list("app_share", bob)).toHaveLength(1);
  });

  it("revoking leaves the grant list empty and the member outside", async () => {
    const { runtime, alice } = await shared();
    await runtime.access.grant("app_share", "org:acme", "viewer", alice);
    expect(await runtime.access.revoke("app_share", "org:acme", alice)).toEqual([]);
    expect(await runtime.access.levelFor("app_share", bob)).toBeNull();
  });

  it("a viewer may NOT grant — proven viewer, denied action, forbidden", async () => {
    const { runtime, access, alice } = await shared();
    await runtime.access.grant("app_share", "org:acme", "viewer", alice);
    // The seam gates too, so the refusal alone cannot tell whose gate answered.
    // The RUNTIME's is the one the MCP door inherits, and it is proven by the
    // seam never being reached — mutate this gate to `viewer` and this is the
    // assertion that goes red.
    const seam = vi.spyOn(access, "grant");
    await expect(runtime.access.grant("app_share", "user:kim", "viewer", bob))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(seam).not.toHaveBeenCalled();
  });

  it("a stranger is told nothing at all — existence stays masked", async () => {
    const { runtime, access } = await shared();
    const seam = vi.spyOn(access, "grant");
    await expect(runtime.access.list("app_share", ctx("kim"))).rejects.toMatchObject({ code: "not-found" });
    await expect(runtime.access.grant("app_share", "org:acme", "viewer", ctx("kim")))
      .rejects.toMatchObject({ code: "not-found" });
    expect(seam).not.toHaveBeenCalled();
  });
});
