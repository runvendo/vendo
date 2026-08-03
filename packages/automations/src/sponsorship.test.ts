import {
  VENDO_APP_FORMAT,
  intentHash,
  type AppDocument,
  type ApprovalId,
  type AuditEvent,
  type Guard,
  type RunContext,
  type StoreAdapter,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import type { AppsRuntime } from "@vendoai/apps";
import { beforeEach, describe, expect, it } from "vitest";
import { createAutomations, type AutomationsConfig, type AutomationsEngine } from "./index.js";
import { appIntentOf, SPONSORED, SPONSORSHIPS, type Sponsorship } from "./sponsorship.js";

/** Contract §9.9 — sponsorship: an automation always runs as a named person.
 *  Every gate below is a red-green pair: the same fire is shown RUNNING while
 *  the sponsorship holds and STOPPING once it does not, so a gate that stopped
 *  gating would fail here instead of passing quietly. */

const NOW = new Date("2026-08-01T09:00:00.000Z");

const readTool: ToolDescriptor = {
  name: "host_readAccounts",
  description: "Read the accounts",
  inputSchema: { type: "object" },
  risk: "read",
};

const writeTool: ToolDescriptor = {
  name: "host_updateInvoice",
  description: "Update an invoice",
  inputSchema: { type: "object" },
  risk: "write",
};

const ctx = (subject = "user_dana", display?: string): RunContext => ({
  principal: { kind: "user", subject, ...(display === undefined ? {} : { display }) },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

const doc = (id: string, name = "Weekly invoice sweep"): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name,
  trigger: {
    on: { kind: "host-event", event: "go" },
    run: {
      kind: "steps",
      steps: [
        { id: "read", tool: readTool.name },
        { id: "write", tool: writeTool.name, args: { invoice: "'inv_42'" } },
      ],
    },
  },
});

const seedApp = async (
  store: StoreAdapter,
  document: AppDocument,
  subject = "user_dana",
  enabled = true,
): Promise<void> => {
  await store.records("vendo_apps").put({
    id: document.id,
    data: { subject, enabled, doc: document },
    refs: { subject, ...(document.trigger === undefined ? {} : { trigger_kind: document.trigger.on.kind }) },
  });
};

class GuardDouble implements Guard {
  readonly audit: AuditEvent[] = [];
  private readonly callbacks = new Set<(id: ApprovalId, approved: boolean) => void>();

  async check(): Promise<{ action: "run"; decidedBy: "default" }> {
    return { action: "run", decidedBy: "default" };
  }

  async report(event: AuditEvent): Promise<void> {
    this.audit.push(structuredClone(event));
  }

  async directions(): Promise<string[]> { return []; }

  onApprovalDecision(callback: (id: ApprovalId, approved: boolean) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  decide(id: string, approved: boolean): void {
    for (const callback of this.callbacks) callback(id, approved);
  }
}

const appsDouble = (): AppsRuntime => ({ call: async () => ({ status: "ok", output: {} }) } as AppsRuntime);

const flush = async (): Promise<void> => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); };

interface Harness {
  store: StoreAdapter;
  guard: GuardDouble;
  engine: AutomationsEngine;
  calls: Array<{ call: ToolCall; ctx: RunContext }>;
}

const harness = (
  overrides: Partial<AutomationsConfig> = {},
  /** Scripted outcomes per execution, so a test can park a call. */
  plan: (call: ToolCall, index: number) => ToolOutcome | undefined = () => undefined,
): Harness => {
  const store = overrides.store ?? memoryStoreAdapter();
  const guard = new GuardDouble();
  const calls: Array<{ call: ToolCall; ctx: RunContext }> = [];
  const tools: ToolRegistry = {
    async descriptors() { return [readTool, writeTool]; },
    async execute(call, runCtx): Promise<ToolOutcome> {
      const index = calls.length;
      calls.push({ call: structuredClone(call), ctx: structuredClone(runCtx) });
      return plan(call, index) ?? { status: "ok", output: {} };
    },
  };
  const engine = createAutomations({
    apps: appsDouble(), tools, guard, store, now: () => NOW, ...overrides,
  });
  return { store, guard, engine, calls };
};

const sponsorshipRow = async (store: StoreAdapter, appId: string): Promise<Sponsorship | undefined> =>
  (await store.records(SPONSORSHIPS).get(appId))?.data as Sponsorship | undefined;

const setSponsorship = async (store: StoreAdapter, row: Sponsorship): Promise<void> => {
  await store.records(SPONSORSHIPS).put({ id: row.appId, data: row, refs: { subject: row.sponsor } });
};

/** `can(editor)` as lane G freezes it (§9.3), stubbed: editor for the listed
 *  subjects, nobody else. Automations takes it as config and never imports
 *  the store, so this stub is the same shape production wires. The set is
 *  mutable so a test can REVOKE access the way a real revoke does. */
const appAccessStub = (
  editors: string[] | Set<string>,
): NonNullable<AutomationsConfig["appAccess"]> => {
  const allowed = editors instanceof Set ? editors : new Set(editors);
  return {
    async can(runCtx, _level, _thing) { return allowed.has(runCtx.principal.subject); },
    async list() { return [...allowed].map((principal) => ({ principal, level: "editor" })); },
  };
};

describe("sponsorship — minted at enable", () => {
  let store: StoreAdapter;

  beforeEach(() => { store = memoryStoreAdapter(); });

  it("mints an active sponsorship over the app's intent when the owner enables it", async () => {
    const app = doc("app_mint");
    await seedApp(store, app, "user_dana", false);
    const { engine } = harness({ store });

    expect(await sponsorshipRow(store, app.id)).toBeUndefined();
    await engine.enable(app.id, ctx());

    expect(await sponsorshipRow(store, app.id)).toMatchObject({
      appId: app.id,
      sponsor: "user_dana",
      status: "active",
      intentHash: intentHash(appIntentOf(app)),
    });
  });

  it("refs the row to both erase axes, so no dangling name survives either cascade", async () => {
    const app = doc("app_erasable");
    await seedApp(store, app, "user_dana", false);
    const { engine } = harness({ store });
    await engine.enable(app.id, ctx());

    expect((await store.records(SPONSORSHIPS).get(app.id))?.refs)
      .toEqual({ subject: "user_dana", app_id: app.id });
  });

  it("re-enabling after an invalidation refreshes the row to the enabler", async () => {
    const app = doc("app_remint");
    await seedApp(store, app, "user_dana", false);
    const { engine } = harness({ store });
    await setSponsorship(store, {
      appId: app.id, sponsor: "user_gone", intentHash: "sha256:stale",
      status: "invalidated", reason: "departure", invalidatedAt: NOW.toISOString(),
    });

    await engine.enable(app.id, ctx());

    expect(await sponsorshipRow(store, app.id)).toMatchObject({
      sponsor: "user_dana", status: "active", intentHash: intentHash(appIntentOf(app)),
    });
    expect(await sponsorshipRow(store, app.id)).not.toHaveProperty("reason");
  });
});

describe("sponsorship — the fire-time gate", () => {
  it("runs as the sponsor while the sponsorship holds, and stops loudly once it does not", async () => {
    // RED half: an active, matching sponsorship fires and calls the tools.
    const app = doc("app_gate");
    const green = harness();
    await seedApp(green.store, app);
    await green.engine.enable(app.id, ctx());
    await green.engine.emit("go", {}, ctx().principal);
    expect(green.calls.map(({ call }) => call.tool)).toEqual([readTool.name, writeTool.name]);
    expect(green.calls[0]?.ctx.principal.subject).toBe("user_dana");

    // GREEN half: someone else edits the app; the very same fire stops before
    // any tool call at all.
    const stopped = harness();
    await seedApp(stopped.store, app);
    await stopped.engine.enable(app.id, ctx());
    await stopped.engine.onDocumentEdit(app, doc(app.id, "Weekly sweep (edited)"), "user_omar");
    const runIds = await stopped.engine.emit("go", {}, ctx().principal);

    expect(stopped.calls).toEqual([]);
    const run = await stopped.engine.runs.get(runIds[0]!, ctx());
    expect(run?.status).toBe("error");
    expect(run?.summary).toMatch(/stopped/i);
    expect(stopped.guard.audit.some((event) =>
      (event.detail as { status?: string }).status === "sponsorship-invalidated")).toBe(true);
  });

  it("stops when the sponsor can no longer edit the app (grants), and runs when they can", async () => {
    // The real departure shape: an ORG-owned app (its row subject is the org, so
    // the sponsor is never its owner) that Dana could edit through a grant —
    // until the grant went away.
    const app = doc("app_departed");
    const editors = new Set(["user_dana"]);
    const { store, engine, calls } = harness({ appAccess: appAccessStub(editors) });
    await seedApp(store, app, "maple");
    await engine.enable(app.id, ctx());

    // RED half: while Dana can still edit it, the fire runs as Dana.
    await engine.emit("go", {}, { kind: "user", subject: "maple" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.ctx.principal.subject).toBe("user_dana");

    editors.delete("user_dana");
    await engine.emit("go", {}, { kind: "user", subject: "maple" });

    expect(calls).toHaveLength(2);
    // §9.9's word for "the person is still here and lost access" is `grants`;
    // `departure` is reserved for a sponsor who is GONE (row erased).
    expect(await sponsorshipRow(store, app.id)).toMatchObject({
      status: "invalidated", reason: "grants",
    });
  });

  it("stops when the stored intent no longer matches the live document", async () => {
    const app = doc("app_drifted");
    const { store, engine, calls } = harness();
    await seedApp(store, app);
    await engine.enable(app.id, ctx());
    // An edit that never reached the hook (a direct row write, or a hook not
    // yet wired) must still fail closed at fire time.
    await seedApp(store, doc(app.id, "Renamed behind the engine's back"));

    await engine.emit("go", {}, ctx().principal);

    expect(calls).toEqual([]);
    expect(await sponsorshipRow(store, app.id)).toMatchObject({ status: "invalidated", reason: "edit" });
  });

  it("resolves memberships for the fire and rides them onto the run context", async () => {
    const app = doc("app_memberships");
    const seen: RunContext[] = [];
    const { store, engine } = harness({
      memberships: async () => [{ org: "maple", admin: false }],
      appAccess: {
        async can(runCtx) { seen.push(structuredClone(runCtx)); return true; },
      },
    });
    await seedApp(store, app);
    await engine.enable(app.id, ctx());
    await engine.emit("go", {}, ctx().principal);

    // The FIRE's check — `enable` also asks `can(editor)`, but that one has a
    // person present and a session behind it; the unattended one is the reason
    // the memberships seam is keyed on Principal at all.
    const fired = seen.filter((seenCtx) => seenCtx.presence === "away");
    expect(fired[0]).toMatchObject({
      principal: { subject: "user_dana" },
      presence: "away",
      memberships: [{ org: "maple" }],
    });
  });
});

/** F1 (verifier repro) — a run that PARKED on an approval resumes later, from a
 *  different door (the guard's decision callback), and re-reads the app document
 *  it never re-checked. The gate has to run again there or a third party can
 *  edit the doc while the run is parked and have the sponsor's identity execute
 *  the edited call. */
describe("sponsorship — the resume gate", () => {
  const parkOnce = (store: StoreAdapter) => (call: ToolCall, index: number): ToolOutcome | undefined => {
    if (index !== 0) return undefined;
    void store.records("vendo_approvals").put({
      id: "apr_parked",
      data: {
        request: {
          id: "apr_parked",
          call: structuredClone(call),
          descriptor: writeTool,
          inputPreview: "update the invoice",
          ctx: { principal: { kind: "user", subject: "user_dana" }, venue: "automation", presence: "away" },
          createdAt: NOW.toISOString(),
        },
        status: "pending",
      },
    });
    return { status: "pending-approval", approvalId: "apr_parked" };
  };

  const oneWriteStep = (id: string, invoice: string): AppDocument => ({
    format: VENDO_APP_FORMAT,
    id,
    name: "Weekly invoice sweep",
    trigger: {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [{ id: "write", tool: writeTool.name, args: { invoice: `'${invoice}'` } }] },
    },
  });

  it("resumes an approved parked call when the document is untouched", async () => {
    const store = memoryStoreAdapter();
    const app = oneWriteStep("app_resume_ok", "inv_42");
    const { engine, guard, calls } = harness({ store }, parkOnce(store));
    await seedApp(store, app);
    await engine.enable(app.id, ctx());
    const [runId] = await engine.emit("go", {}, ctx().principal);
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({ status: "pending-approval" });

    guard.decide("apr_parked", true);
    await flush();

    // The exact parked call replays — resume semantics are untouched.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.call.args).toEqual({ invoice: "inv_42" });
    expect(calls[1]?.ctx.principal.subject).toBe("user_dana");
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({ status: "ok" });
  });

  /** N1 (verifier variant D) — the gate checks the CURRENT state, which an
   *  adoption between park and resume satisfies perfectly: the sponsorship is
   *  active, the intent matches, the new sponsor can edit. But the parked
   *  approval belongs to the PREVIOUS era: resuming it would execute a call the
   *  new sponsor never saw under their identity, and mint the grant under the
   *  old sponsor. A run may only be resumed by the person who was asked. */
  it("refuses to resume a parked approval from a previous sponsor's era", async () => {
    const store = memoryStoreAdapter();
    const app = oneWriteStep("app_resume_adopted", "inv_42");
    const { engine, guard, calls } = harness(
      { store, appAccess: appAccessStub(["user_dana", "user_omar"]) },
      parkOnce(store),
    );
    await seedApp(store, app);
    await engine.enable(app.id, ctx("user_dana", "Dana"));
    const [runId] = await engine.emit("go", {}, ctx().principal);
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({ status: "pending-approval" });

    // The automation changes hands while the run sits parked: someone else edits
    // it, and a different editor adopts it — so by the time the approval is
    // decided, the automation runs as Omar.
    await engine.onDocumentEdit(app, app, "user_omar");
    expect((await engine.adopt(app.id, ctx("user_omar", "Omar"))).adopted).toBe(true);

    guard.decide("apr_parked", true);
    await flush();

    // Never resumed…
    expect(calls).toHaveLength(1);
    const run = await engine.runs.get(runId!, ctx());
    expect(run?.status).toBe("error");
    expect(run?.summary).toMatch(/run it again/i);
    expect(guard.audit.some((event) =>
      (event.detail as { status?: string }).status === "sponsorship-changed")).toBe(true);
    // …and never minted: the parked approval was Dana's, and nothing about
    // Omar's adoption grants Dana anything.
    expect((await store.records("vendo_grants").list()).records).toEqual([]);
    expect(await store.records("automations:parked").get("apr_parked")).toBeNull();
  });

  it("refuses to resume once a third party has edited the document", async () => {
    const store = memoryStoreAdapter();
    const app = oneWriteStep("app_resume_evil", "inv_42");
    const { engine, guard, calls } = harness({ store }, parkOnce(store));
    await seedApp(store, app);
    await engine.enable(app.id, ctx());
    const [runId] = await engine.emit("go", {}, ctx().principal);

    // Somebody else rewrites the automation while the run sits parked.
    const edited = oneWriteStep(app.id, "inv_EVIL");
    await seedApp(store, edited);
    await engine.onDocumentEdit(app, edited, "user_omar");

    guard.decide("apr_parked", true);
    await flush();

    // Nothing executed a second time — not the parked call, and certainly not
    // the edited one — and the run is a loud terminal failure, not a stranded
    // "running" row.
    expect(calls).toHaveLength(1);
    const run = await engine.runs.get(runId!, ctx());
    expect(run?.status).toBe("error");
    expect(run?.summary).toMatch(/stopped/i);
    expect(guard.audit.some((event) =>
      (event.detail as { status?: string }).status === "sponsorship-invalidated")).toBe(true);
    expect(await store.records("automations:parked").get("apr_parked")).toBeNull();
  });
});

describe("sponsorship — invalidation on a third party's edit", () => {
  it("invalidates for another editor and survives the sponsor's own edit", async () => {
    const app = doc("app_edits");
    const { store, engine } = harness();
    await seedApp(store, app);
    await engine.enable(app.id, ctx());

    const renamed = doc(app.id, "Sponsor's own rename");
    await engine.onDocumentEdit(app, renamed, "user_dana");
    expect(await sponsorshipRow(store, app.id)).toMatchObject({
      status: "active",
      sponsor: "user_dana",
      // The sponsor's own edit re-binds the intent instead of stranding it:
      // otherwise the fire-time hash check would stop the automation for an
      // edit its own sponsor made.
      intentHash: intentHash(appIntentOf(renamed)),
    });

    await engine.onDocumentEdit(renamed, doc(app.id, "Someone else's rename"), "user_omar");
    expect(await sponsorshipRow(store, app.id)).toMatchObject({ status: "invalidated", reason: "edit" });
  });

  it("leaves an already-invalidated row alone rather than restamping it", async () => {
    const app = doc("app_idempotent");
    const { store, engine } = harness();
    await seedApp(store, app);
    await engine.enable(app.id, ctx());
    await engine.onDocumentEdit(app, app, "user_omar");
    const first = await sponsorshipRow(store, app.id);

    await engine.onDocumentEdit(app, app, "user_zoe");

    expect(await sponsorshipRow(store, app.id)).toEqual(first);
  });
});

/** F3 — the sponsorship row carries the sponsor's subject, so a subject erase
 *  DELETES it. Without a trace that the app was ever sponsored, the fire-time
 *  gate would read "no sponsorship" and quietly hand the automation back to the
 *  app's owner. The era marker is that trace: keyed to the app only, so a
 *  subject erase cannot collect it and an app erase can. */
describe("sponsorship — an erased sponsor", () => {
  /** What `eraseStore.bySubject` does to the row: it matches generic records on
   *  `refs @> {subject}`. The row's refs are asserted separately. */
  const eraseSponsorRow = async (store: StoreAdapter, appId: string): Promise<void> => {
    await store.records(SPONSORSHIPS).delete(appId);
  };

  it("carries no subject data on the era marker, so a subject erase cannot collect it", async () => {
    const app = doc("app_era");
    const { store, engine } = harness();
    await seedApp(store, app);
    await engine.enable(app.id, ctx());

    const marker = await store.records(SPONSORED).get(app.id);
    expect(marker?.refs).toEqual({ app_id: app.id });
    expect(JSON.stringify(marker?.data)).not.toContain("user_dana");
  });

  it("stops the automation and waits for adoption instead of reverting to the owner", async () => {
    const app = doc("app_erased_sponsor");
    const { store, engine, calls } = harness({ appAccess: appAccessStub(["user_dana", "user_omar"]) });
    await seedApp(store, app);
    await engine.enable(app.id, ctx("user_dana", "Dana"));
    await eraseSponsorRow(store, app.id);

    await engine.emit("go", {}, ctx().principal);

    expect(calls).toEqual([]);
    const card = await engine.adoption(app.id, ctx("user_omar"));
    expect(card).toMatchObject({ appId: app.id, reason: "departure" });
    // Anonymously: the erased subject must not come back through the card.
    expect(card?.sponsor).toBeUndefined();
    expect(JSON.stringify(card)).not.toContain("user_dana");
  });

  it("still lets a pre-sponsorship automation (no marker at all) run as its owner", async () => {
    const app = doc("app_legacy");
    const { store, engine, calls } = harness();
    await seedApp(store, app);
    await engine.enable(app.id, ctx());
    await eraseSponsorRow(store, app.id);
    await store.records(SPONSORED).delete(app.id);

    await engine.emit("go", {}, ctx().principal);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.ctx.principal.subject).toBe("user_dana");
  });
});

/** F9 — nothing a person reads should say `user_dana`. The sponsor's own
 *  display name is captured at enable and at adoption (their Principal carries
 *  it) and used everywhere the automation talks about them. */
describe("sponsorship — consumer-voice names", () => {
  it("captures the sponsor's display name and uses it on the adoption card", async () => {
    // F8 (wave-3 check) moved the NAME off the persisted run summary and onto
    // the card: the run row outlives a subject erase, the sponsorship row the
    // card is derived from does not. The consumer-voice law is unchanged —
    // nothing a person reads says `user_dana`.
    const app = doc("app_named");
    const { store, engine } = harness();
    await seedApp(store, app);
    await engine.enable(app.id, ctx("user_dana", "Dana"));
    expect(await sponsorshipRow(store, app.id)).toMatchObject({ display: "Dana" });

    await engine.onDocumentEdit(app, app, "user_omar");
    const runIds = await engine.emit("go", {}, ctx().principal);
    const run = await engine.runs.get(runIds[0]!, ctx());
    const card = await engine.adoption(app.id, ctx("user_dana", "Dana"));

    expect(card?.sponsor).toBe("Dana");
    expect(run?.summary).not.toContain("Dana");
    expect(run?.summary).not.toContain("user_dana");
  });

  it("says something human when no display name was ever asserted", async () => {
    const app = doc("app_unnamed");
    const { store, engine } = harness();
    await seedApp(store, app);
    await engine.enable(app.id, ctx());
    await engine.onDocumentEdit(app, app, "user_omar");
    const card = await engine.adoption(app.id, ctx());

    // The subject is the only identifier the host gave us; it is the last
    // resort, not a phrase invented about a real person.
    expect(card?.sponsor).toBe("user_dana");
  });
});

/** F10 — the identity checks call HOST code (a memberships callback, an access
 *  seam). They run before the run row is written, and the schedule path swallows
 *  a rejected run, so a throw there used to make the whole firing vanish: no
 *  row, no audit, nothing to look at. */
describe("sponsorship — a broken identity seam", () => {
  const scheduled = (id: string): AppDocument => ({
    format: VENDO_APP_FORMAT,
    id,
    name: "Weekly invoice sweep",
    trigger: {
      on: { kind: "schedule", every: "1h" },
      run: { kind: "steps", steps: [{ id: "read", tool: readTool.name }] },
    },
  });

  it("leaves a loud failure artifact when the memberships callback throws on a scheduled fire", async () => {
    const app = scheduled("app_seam_broken");
    const { store, engine, guard, calls } = harness({
      memberships: async () => { throw new Error("host directory is down"); },
    });
    await seedApp(store, app);
    await engine.enable(app.id, ctx());

    const [runId] = await engine.tick(new Date(NOW.getTime() + 2 * 3_600_000));

    expect(calls).toEqual([]);
    expect(runId).toBeDefined();
    const run = await engine.runs.get(runId!, ctx());
    expect(run).toMatchObject({ status: "error" });
    // F10 (wave-3 check): the host's raw throw is the AUDIT row's, never the
    // consumer's — the panel renders `summary` and `error.message` verbatim.
    expect(run?.error?.message).not.toContain("host directory is down");
    expect(guard.audit.some((event) =>
      (event.detail as { status?: string; detail?: string }).status === "sponsorship-check-failed"
      && (event.detail as { detail?: string }).detail === "host directory is down")).toBe(true);
  });

  it("terminates a claimed RESUME loudly rather than stranding it in \"running\"", async () => {
    const store = memoryStoreAdapter();
    const app: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_seam_resume",
      name: "Weekly invoice sweep",
      trigger: {
        on: { kind: "host-event", event: "go" },
        run: { kind: "steps", steps: [{ id: "write", tool: writeTool.name, args: { invoice: "'inv_42'" } }] },
      },
    };
    let breakSeam = false;
    const { engine, guard, calls } = harness(
      { store, memberships: async () => { if (breakSeam) throw new Error("host directory is down"); return []; } },
      (call, index) => {
        if (index !== 0) return undefined;
        void store.records("vendo_approvals").put({
          id: "apr_seam",
          data: {
            request: {
              id: "apr_seam",
              call: structuredClone(call),
              descriptor: writeTool,
              inputPreview: "update the invoice",
              ctx: { principal: { kind: "user", subject: "user_dana" }, venue: "automation", presence: "away" },
              createdAt: NOW.toISOString(),
            },
            status: "pending",
          },
        });
        return { status: "pending-approval", approvalId: "apr_seam" };
      },
    );
    await seedApp(store, app);
    await engine.enable(app.id, ctx());
    const [runId] = await engine.emit("go", {}, ctx().principal);

    breakSeam = true;
    guard.decide("apr_seam", true);
    await flush();

    expect(calls).toHaveLength(1);
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({ status: "error" });
    expect(guard.audit.some((event) =>
      (event.detail as { status?: string }).status === "sponsorship-check-failed")).toBe(true);
  });

  it("runs normally when the same callback answers", async () => {
    const app = scheduled("app_seam_ok");
    const { store, engine, calls } = harness({ memberships: async () => [{ org: "maple" }] });
    await seedApp(store, app);
    await engine.enable(app.id, ctx());

    const [runId] = await engine.tick(new Date(NOW.getTime() + 2 * 3_600_000));

    expect(calls).toHaveLength(1);
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({ status: "ok" });
  });
});

/** F12 — the consent rows are generic records, and the 02-store §5 erase cascade
 *  finds generic rows by their REFS. Without them a subject erase (or an app
 *  delete) leaves the automation's pending asks behind. */
describe("sponsorship — consent rows join the erase cascade", () => {
  it("refs every capture it writes to the subject and the app", async () => {
    const app = doc("app_refs");
    const { store, engine } = harness();
    await seedApp(store, app, "user_dana", false);
    const { missing } = await engine.enable(app.id, ctx());

    expect(missing).not.toHaveLength(0);
    for (const request of missing) {
      expect((await store.records("automations:captures").get(request.id))?.refs)
        .toEqual({ subject: "user_dana", app_id: app.id });
    }
  });

  it("relies on the approvals table's own derived refs, which survive a re-put", async () => {
    // `vendo_approvals` is RESERVED: the store derives its refs from the request
    // and ignores whatever a caller passes, and the cascade deletes it by its
    // subject COLUMN. Asserted rather than assumed, because it is the reason
    // captures needed refs and approvals did not.
    const app = doc("app_refs_reserved");
    const { store, engine, guard } = harness();
    await seedApp(store, app, "user_dana", false);
    const { missing } = await engine.enable(app.id, ctx());
    expect((await store.records("vendo_approvals").get(missing[0]!.id))?.refs)
      .toMatchObject({ subject: "user_dana" });

    guard.decide(missing[0]!.id, true);
    await flush();

    const consumed = await store.records("vendo_approvals").get(missing[0]!.id);
    expect(consumed?.data).toMatchObject({ consumedAt: NOW.toISOString() });
    expect(consumed?.refs).toMatchObject({ subject: "user_dana" });
  });
});

describe("sponsorship — the adoption card", () => {
  it("appears for an editor once the automation stops, and never for a non-editor", async () => {
    const app = doc("app_card");
    const { store, engine } = harness({ appAccess: appAccessStub(["user_dana", "user_omar"]) });
    await seedApp(store, app);
    await engine.enable(app.id, ctx());

    // Nothing to adopt while the sponsorship holds.
    expect(await engine.adoption(app.id, ctx("user_omar"))).toBeUndefined();

    await engine.onDocumentEdit(app, app, "user_omar");
    const card = await engine.adoption(app.id, ctx("user_omar"));

    expect(card).toMatchObject({
      appId: app.id,
      automation: app.name,
      sponsor: "user_dana",
      reason: "edit",
    });
    // §12 completeness: one line per read/write, real titles, material
    // arguments where they exist — never one summary line for a compound.
    expect(card?.needs).toEqual([
      { tool: readTool.name, title: readTool.name, description: readTool.description, risk: "read" },
      {
        tool: writeTool.name,
        title: writeTool.name,
        description: writeTool.description,
        risk: "write",
        args: { invoice: "'inv_42'" },
      },
    ]);

    expect(await engine.adoption(app.id, ctx("user_stranger"))).toBeUndefined();
  });
});

describe("sponsorship — adoption", () => {
  it("re-mints the grants under the adopter, and the automation then runs as them", async () => {
    const app = doc("app_adopt");
    const { store, guard, engine, calls } = harness({ appAccess: appAccessStub(["user_dana", "user_omar"]) });
    await seedApp(store, app);
    await engine.enable(app.id, ctx());
    await engine.onDocumentEdit(app, app, "user_omar");

    const adopted = await engine.adopt(app.id, ctx("user_omar"));

    expect(adopted.adopted).toBe(true);
    expect(adopted.missing.map((request) => request.call.tool)).toEqual([readTool.name, writeTool.name]);
    expect(adopted.missing.every((request) => request.ctx.principal.subject === "user_omar")).toBe(true);
    expect(await sponsorshipRow(store, app.id)).toMatchObject({
      sponsor: "user_omar", status: "active", intentHash: intentHash(appIntentOf(app)),
    });

    for (const request of adopted.missing) guard.decide(request.id, true);
    await flush();
    const grants = (await store.records("vendo_grants").list()).records;
    expect(grants.map((record) => (record.data as { subject: string }).subject)).toEqual(["user_omar", "user_omar"]);

    await engine.emit("go", {}, ctx().principal);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.ctx.principal.subject).toBe("user_omar");
  });

  it("lets exactly one editor win — the loser hears that it is already adopted", async () => {
    const app = doc("app_race");
    const { store, engine } = harness({ appAccess: appAccessStub(["user_dana", "user_omar", "user_zoe"]) });
    await seedApp(store, app);
    await engine.enable(app.id, ctx());
    await engine.onDocumentEdit(app, app, "user_omar");

    expect((await engine.adopt(app.id, ctx("user_omar"))).adopted).toBe(true);
    const loser = await engine.adopt(app.id, ctx("user_zoe"));

    expect(loser).toMatchObject({ adopted: false, reason: "already-adopted" });
    expect(await sponsorshipRow(store, app.id)).toMatchObject({ sponsor: "user_omar" });
  });

  it("refuses a non-editor", async () => {
    const app = doc("app_adopt_denied");
    const { store, engine } = harness({ appAccess: appAccessStub(["user_dana"]) });
    await seedApp(store, app);
    await engine.enable(app.id, ctx());
    await engine.onDocumentEdit(app, app, "user_omar");

    await expect(engine.adopt(app.id, ctx("user_stranger"))).rejects.toThrow(/not found/i);
  });
});

/** F6 — after adoption the automation runs as the ADOPTER, who may not own the
 *  app. §8's editor = edit, so every door the owner has is the editor's too —
 *  otherwise the person it runs as cannot see it, pause it, or stop it. */
describe("sponsorship — an editor's doors", () => {
  const adopted = async (): Promise<Harness & { app: AppDocument }> => {
    const app = doc("app_editor_doors");
    const bench = harness({ appAccess: appAccessStub(["user_dana", "user_omar"]) });
    await seedApp(bench.store, app);
    await bench.engine.enable(app.id, ctx("user_dana", "Dana"));
    await bench.engine.onDocumentEdit(app, app, "user_omar");
    await bench.engine.adopt(app.id, ctx("user_omar", "Omar"));
    return { ...bench, app };
  };

  it("lists the automation for the person it now runs as", async () => {
    const { engine, app } = await adopted();

    const [entry] = await engine.list(ctx("user_omar", "Omar"));

    expect(entry?.app.id).toBe(app.id);
    expect(entry?.sponsor).toEqual({ subject: "user_omar", display: "Omar" });
  });

  it("names the sponsor to the OWNER too, from the row rather than the caller", async () => {
    const { engine } = await adopted();

    const [entry] = await engine.list(ctx("user_dana", "Dana"));

    expect(entry?.sponsor).toEqual({ subject: "user_omar", display: "Omar" });
  });

  it("lets an editor see, dry-run, stop and disable it — and a stranger none of that", async () => {
    const { engine, app, store } = await adopted();
    const [runId] = await engine.emit("go", {}, ctx().principal);

    const editor = ctx("user_omar", "Omar");
    expect(await engine.runs.get(runId!, editor)).toMatchObject({ id: runId });
    expect((await engine.runs.list({ appId: app.id }, editor)).runs).toHaveLength(1);
    expect((await engine.dryRun(app.id, editor)).steps).toHaveLength(2);
    await engine.disable(app.id, editor);
    expect((await store.records("vendo_apps").get(app.id))?.data).toMatchObject({ enabled: false });

    const stranger = ctx("user_zoe");
    expect(await engine.runs.get(runId!, stranger)).toBeNull();
    expect((await engine.runs.list({ appId: app.id }, stranger)).runs).toEqual([]);
    await expect(engine.dryRun(app.id, stranger)).rejects.toThrow(/not found/i);
    await expect(engine.disable(app.id, stranger)).rejects.toThrow(/not found/i);
    expect(await engine.list(stranger)).toEqual([]);
  });

  it("stops a run for the editor it runs as", async () => {
    const { engine, app } = await adopted();
    const { store } = harness();
    void store;
    const editor = ctx("user_omar", "Omar");
    await engine.emit("go", {}, ctx().principal);
    const [run] = (await engine.runs.list({ appId: app.id }, editor)).runs;

    // A finished run cannot be stopped — the door is what is under test, so a
    // non-editor must hear "not found" while the editor hears the real conflict.
    await expect(engine.runs.stop(run!.id, ctx("user_zoe"))).rejects.toThrow(/not found/i);
    await expect(engine.runs.stop(run!.id, editor)).rejects.toThrow(/cannot be stopped/i);
  });
});

describe("sponsorship — the window label", () => {
  it("names the sponsor and the wider editor set on list()", async () => {
    const app = doc("app_label");
    const { store, engine } = harness({ appAccess: appAccessStub(["user_dana", "user_omar"]) });
    await seedApp(store, app);
    await engine.enable(app.id, ctx("user_dana", "Dana"));

    const [entry] = await engine.list(ctx("user_dana", "Dana"));

    expect(entry).toMatchObject({
      sponsor: { subject: "user_dana", display: "Dana" },
      editors: 2,
    });
  });

  it("omits the editor count when no access seam is configured", async () => {
    const app = doc("app_label_solo");
    const { store, engine } = harness();
    await seedApp(store, app);
    await engine.enable(app.id, ctx());

    const [entry] = await engine.list(ctx());

    expect(entry?.sponsor).toEqual({ subject: "user_dana" });
    expect(entry).not.toHaveProperty("editors");
  });
});

/** F8/F10/F18 (wave-3 independent check) — what a STOPPED run is allowed to
 *  leave behind. Two constraints meet on the same row:
 *
 *  1. It is read by people: `automations-panel.tsx` renders `summary` and
 *     `error.message` verbatim.
 *  2. It is not reachable by a subject erase. `vendo_runs` has no subject column
 *     (02-store §2), so the cascade reaches run rows only through the apps the
 *     subject OWNS — and for an ORG-owned automation the owner is the org, which
 *     outlives the person (§9.7). Adoption is exactly what makes sponsor ≠
 *     row-owner possible, so this wave created the case.
 *
 *  So the persisted row may carry neither a person's NAME nor a host system's
 *  raw error text. The live, derived surfaces (the adoption card, the audit
 *  trail) carry both — and both ARE erasable. */
describe("sponsorship — what the stopped run row is allowed to say", () => {
  /** The raw persisted row, not the gated `runs.get` projection: what survives
   *  an erase is what is ON DISK, whoever can or cannot read it back. */
  const runRow = async (store: StoreAdapter, runId: string): Promise<{ summary?: string; error?: { message: string } }> =>
    ((await store.records("vendo_runs").get(runId))?.data as { record: { summary?: string; error?: { message: string } } })
      .record;

  /** An ORG-owned automation Dana sponsors through a grant — the only shape in
   *  which the sponsor is not the row owner. */
  const orgHarness = async (id: string, editors: Set<string>) => {
    const app = doc(id);
    const h = harness({ appAccess: appAccessStub(editors) });
    await seedApp(h.store, app, "maple");
    await h.engine.enable(app.id, ctx("user_dana", "Dana"));
    return { ...h, app };
  };

  it("calls a lost permission 'grants' — the frozen §9.9 word for it", async () => {
    const editors = new Set(["user_dana"]);
    const { store, engine, app } = await orgHarness("app_grants_label", editors);

    editors.delete("user_dana");
    const [runId] = await engine.emit("go", {}, { kind: "user", subject: "maple" });

    // "departure" is the word for a sponsor who is GONE (their row erased);
    // this sponsor still exists and simply lost access, which is "grants" —
    // and the two produce different consumer sentences.
    expect(await sponsorshipRow(store, app.id)).toMatchObject({
      status: "invalidated", reason: "grants",
    });
    expect((await runRow(store, runId!)).summary).toMatch(/permissions/i);
  });

  it("keeps the sponsor's NAME off the run row, while the adoption card still says it", async () => {
    const editors = new Set(["user_dana", "user_omar"]);
    const { store, engine, app } = await orgHarness("app_name_survives", editors);

    editors.delete("user_dana");
    const [runId] = await engine.emit("go", {}, { kind: "user", subject: "maple" });

    // The row is written BEFORE any erase — that is the whole problem: nothing
    // rewrites it later, so the name must never go in.
    const persisted = JSON.stringify(await store.records("vendo_runs").get(runId!));
    expect(persisted).not.toContain("Dana");
    expect(persisted).not.toContain("user_dana");

    // The name is not lost to the product: the card is derived from the
    // sponsorship row, which an erase DOES collect.
    expect(await engine.adoption(app.id, ctx("user_omar"))).toMatchObject({ sponsor: "Dana" });
  });

  it("says a broken identity seam in the consumer's voice, and audits the raw failure", async () => {
    const app = doc("app_seam_voice");
    const raw = "connect ECONNREFUSED postgres://svc:hunter2@10.0.0.7:5432/directory";
    const { store, engine, guard } = harness({
      memberships: async () => { throw new Error(raw); },
    });
    await seedApp(store, app);
    await engine.enable(app.id, ctx("user_dana", "Dana"));

    const [runId] = await engine.emit("go", {}, ctx().principal);

    const row = await runRow(store, runId!);
    expect(row.summary).not.toContain("ECONNREFUSED");
    expect(row.error?.message).not.toContain("ECONNREFUSED");
    expect(row.summary).toMatch(/could not check who it runs as/);
    // The operator still gets the whole truth — on the audit row, which is
    // subject-keyed and erasable, and which no consumer surface renders.
    expect(guard.audit.some((event) => JSON.stringify(event.detail).includes(raw))).toBe(true);
  });
});

/** E8-F1/E8-F2 (live browser proof, 2026-08-01) — the two ways an automation
 *  became BUILT BUT UNREACHABLE. `list` is the only surface that mentions an
 *  automation outside the app itself, so anything it hides is, in practice, gone:
 *  promote deliberately disarms the automation and the Share dialog promises it
 *  "stays off until someone turns it back on", and an invalidated sponsorship
 *  leaves the adoption card as the only mention anywhere. */
describe("sponsorship — an automation the caller can edit is an automation they can SEE", () => {
  const withOrg = (subject: string, org = "maple"): RunContext =>
    ({ ...ctx(subject), memberships: [{ org }] }) as RunContext;

  it("lists a promoted org app's disarmed automation for an editor, who can turn it back on", async () => {
    // The promoted shape: the row subject is the ORG (§9.5), and promote left it
    // disabled. Before this, `list` matched `row.subject === ctx.subject`, so the
    // automation was listed for NOBODY — not the members, not the org admin, not
    // even the person who promoted it.
    const app = doc("app_promoted");
    const { store, engine } = harness({ appAccess: appAccessStub(["user_kim"]) });
    await seedApp(store, app, "maple", false);

    const listed = await engine.list(withOrg("user_kim"));
    expect(listed.map((entry) => entry.app.id)).toEqual([app.id]);
    expect(listed[0]?.enabled).toBe(false);
    // ...and the promise is keepable: she can arm it from there.
    expect((await engine.enable(app.id, withOrg("user_kim"))).enabled).toBe(true);

    // Someone who asserts no membership and holds no grant still sees nothing.
    expect(await engine.list(ctx("user_mal"))).toEqual([]);
  });

  it("keeps a STOPPED automation visible to its sponsor, with the honest stopped state", async () => {
    // A personal app Dana ADOPTED: she is the sponsor and not the owner, so
    // `sponsoredElsewhere` is her only route to it — and it dropped every row
    // whose sponsorship was not `active`, which is exactly the paused ones.
    const app = doc("app_paused");
    const { store, engine } = harness({ appAccess: appAccessStub(["user_dana"]) });
    await seedApp(store, app, "user_owner");
    await setSponsorship(store, {
      appId: app.id,
      sponsor: "user_dana",
      display: "Dana",
      intentHash: intentHash(appIntentOf(app)),
      status: "invalidated",
      reason: "edit",
      invalidatedAt: NOW.toISOString(),
    });

    const listed = await engine.list(ctx("user_dana"));

    expect(listed.map((entry) => entry.app.id)).toEqual([app.id]);
    expect(listed[0]?.stopped).toMatchObject({ reason: "edit" });
    expect(listed[0]?.stopped?.summary).toMatch(/anyone who can edit this app can take it on/);
  });
});

/** ORCHESTRATOR RULING 2026-08-01 (handoff #5, derived from the locked model) —
 *  an event emitted by a MEMBER of the org fires that org's automations.
 *
 *  `emit` matched apps by the emitter's own subject, so an ORG-owned host-event
 *  automation could never be fired by anybody: the row subject is the org id
 *  (§9.5) and no principal is ever an org (§9.1 keeps `kind:"org"` refused at the
 *  wire). Same "built but unreachable" shape as the `list` defect, and the same
 *  fix shape: walk the orgs the principal asserts, and let the ordinary
 *  fire-time gate decide each run.
 *
 *  As WHOM it runs is unchanged and is not a new question: the SPONSOR (§9.9),
 *  never a synthetic org principal. */
describe("sponsorship — a member's event fires the org's automation", () => {
  /** The org's automation, armed by Dana, who can edit it through the access
   *  seam; Kim is an ordinary member of the same org and emits the event. */
  const orgAutomation = async (id: string, editors: string[] = ["user_dana"]) => {
    const app = doc(id);
    const h = harness({
      appAccess: appAccessStub(editors),
      // §9.1's seam — keyed on Principal precisely so unattended code can ask.
      memberships: async (principal) => principal.subject === "user_mal"
        ? []
        : [{ org: "maple", display: "Maple Bank" }],
    });
    await seedApp(h.store, app, "maple", false);
    await h.engine.enable(app.id, ctx("user_dana", "Dana"));
    return { ...h, app };
  };

  it("fires it for a member, and the run acts as the SPONSOR", async () => {
    const { engine, calls, app } = await orgAutomation("app_org_emit");

    const ids = await engine.emit("go", {}, { kind: "user", subject: "user_kim" });

    expect(ids).toHaveLength(1);
    expect(calls.map(({ call }) => call.tool)).toEqual([readTool.name, writeTool.name]);
    // Kim's event, Dana's access — the automation always runs as the person who
    // took it on, never as the person who happened to trigger it.
    expect(calls[0]?.ctx.principal.subject).toBe("user_dana");
    expect(await engine.runs.get(ids[0]!, ctx("user_dana"))).toMatchObject({
      appId: app.id,
      status: "ok",
    });
  });

  it("fires nothing for a non-member emitting the very same event", async () => {
    const { engine, calls } = await orgAutomation("app_org_emit_stranger");

    const ids = await engine.emit("go", {}, { kind: "user", subject: "user_mal" });

    expect(ids).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("does not run an org automation whose sponsorship has lapsed — and says why", async () => {
    const { store, engine, calls, app } = await orgAutomation("app_org_emit_stopped");
    // A third party edits it: the sponsorship lapses.
    await engine.onDocumentEdit(app, doc(app.id, "Renamed by somebody else"), "user_omar");

    const ids = await engine.emit("go", {}, { kind: "user", subject: "user_kim" });

    // It stops LOUDLY, exactly as a scheduled fire does: a run row and an audit
    // event, and no tool call at all.
    expect(ids).toHaveLength(1);
    expect(calls).toEqual([]);
    const run = await engine.runs.get(ids[0]!, ctx("user_dana"));
    expect(run?.status).toBe("error");
    expect(run?.summary).toMatch(/anyone who can edit this app can take it on/);
    expect(await sponsorshipRow(store, app.id)).toMatchObject({ status: "invalidated" });
  });
});
