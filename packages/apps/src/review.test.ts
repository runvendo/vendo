import { VENDO_APP_FORMAT, type AppDocument, type RunContext, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createInClientApprovals } from "./inclient.js";
import { createApps } from "./index.js";
import { pinComponentName, type PinBaseline } from "./pins.js";
import { createReviewLifecycle } from "./review.js";
import { guardFixture, memoryStore, scriptedLanguageModel, seedAppRow } from "./testing/index.js";
import { appVersionHash } from "./version-hash.js";

const tools: ToolRegistry = {
  async descriptors() {
    return [];
  },
  async execute() {
    return { status: "error", error: { code: "not-found", message: "No fixture tools" } };
  },
};

const context = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `session_${subject}`,
});

/** A review-kind capture beside an instant one: kind is baseline metadata. */
const reviewedBaseline: PinBaseline = {
  slot: "transfer-panel",
  source: "export default function TransferPanel() { return <b>host</b>; }",
  hash: "sha256:transfer-base",
  exportable: true,
  capturedAt: "2026-08-01T12:00:00.000Z",
  review: true,
};

const instantBaseline: PinBaseline = {
  slot: "hero-card",
  source: "export default function Hero() { return <b>host</b>; }",
  hash: "sha256:hero-base",
  exportable: true,
  capturedAt: "2026-08-01T12:00:00.000Z",
};

const doc = (slot: string, overrides: Partial<AppDocument> = {}): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: `app_review_${slot.replaceAll("-", "_")}`,
  name: `${slot} remix`,
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: ["fork"] },
      { id: "fork", component: pinComponentName(slot), source: "generated" },
    ],
  },
  pins: [{ slot, base: `sha256:${slot === "transfer-panel" ? "transfer" : "hero"}-base` }],
  components: {
    [pinComponentName(slot)]: "export default function Fork() { return <b>fork</b>; }",
  },
  ...overrides,
});

const setup = () => {
  const store = memoryStore();
  const guard = guardFixture();
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    pinBaselines: [reviewedBaseline, instantBaseline],
    model: scriptedLanguageModel('<Edit><SetName name="Edited name"/></Edit>'),
  });
  return { store, guard, runtime };
};

const owner = context("user_ada");
const reviewer = context("host_reviewer");

describe("review-kind gating in open()", () => {
  it("an unapproved review-kind remix answers pending-review and ships NO executable source", async () => {
    const { store, runtime } = setup();
    const app = doc("transfer-panel");
    await seedAppRow(store, app, owner.principal.subject);

    const surface = await runtime.open(app.id, owner);
    if (surface.kind !== "tree") throw new Error("expected tree surface");
    expect((surface.payload as { inClient?: unknown }).inClient).toEqual({
      granted: false,
      versionHash: appVersionHash(app),
      reason: "pending-review",
      review: { status: "pending", versionHash: appVersionHash(app) },
    });
    // A jailed render can NEVER occur: no fork source travels — not on the
    // surface, not in the payload, not as jail furnishings or island tools.
    expect(surface.components).toBeUndefined();
    const payload = surface.payload as {
      components?: unknown;
      componentTools?: unknown;
      furnishings?: unknown;
    };
    expect(payload.components).toBeUndefined();
    expect(payload.componentTools).toBeUndefined();
    expect(payload.furnishings).toBeUndefined();
  });

  it("an instant-kind remix is completely unaffected (regression)", async () => {
    const { store, runtime } = setup();
    const app = doc("hero-card");
    await seedAppRow(store, app, owner.principal.subject);

    const surface = await runtime.open(app.id, owner);
    if (surface.kind !== "tree") throw new Error("expected tree surface");
    // Jailed by default, source present: exactly the pre-review behavior.
    expect((surface.payload as { inClient?: unknown }).inClient).toBeUndefined();
    expect(surface.components).toEqual(app.components);
  });
});

describe("approval swaps the served version", () => {
  it("approve grants native for that hash; an edit leaves the approved version rendering; approving the new version swaps", async () => {
    const { store, runtime } = setup();
    const v1 = doc("transfer-panel");
    await seedAppRow(store, v1, owner.principal.subject);
    const v1Hash = appVersionHash(v1);

    await runtime.inClient.approve({ appId: v1.id, approvedBy: "host-console" }, owner);
    const approved = await runtime.open(v1.id, owner);
    if (approved.kind !== "tree") throw new Error("expected tree surface");
    expect((approved.payload as { inClient?: unknown }).inClient).toMatchObject({
      granted: true,
      versionHash: v1Hash,
      approvedBy: "host-console",
    });
    expect(approved.components).toEqual(v1.components);

    // Edit → a NEW version is pending; the LAST approved version keeps
    // rendering natively, with the new version's standing riding along.
    const edited = await runtime.edit(v1.id, "Rename it", owner);
    expect(edited.failure).toBeUndefined();
    const v2Hash = appVersionHash(edited.app);
    expect(v2Hash).not.toBe(v1Hash);

    const during = await runtime.open(v1.id, owner);
    if (during.kind !== "tree") throw new Error("expected tree surface");
    expect((during.payload as { inClient?: unknown }).inClient).toEqual({
      granted: true,
      versionHash: v1Hash,
      approvedBy: "host-console",
      at: expect.any(String) as unknown as string,
      review: { status: "pending", versionHash: v2Hash },
    });
    expect(during.components).toEqual(v1.components);

    // Approving the new version swaps it in, rider gone.
    await runtime.inClient.approve({ appId: v1.id, approvedBy: "host-console" }, owner);
    const swapped = await runtime.open(v1.id, owner);
    if (swapped.kind !== "tree") throw new Error("expected tree surface");
    expect((swapped.payload as { inClient?: { versionHash?: string; review?: unknown } }).inClient).toMatchObject({
      granted: true,
      versionHash: v2Hash,
    });
    expect((swapped.payload as { inClient?: { review?: unknown } }).inClient?.review).toBeUndefined();
  });

  it("an approval whose version left the capped history fails closed to pending-review, never the jail", async () => {
    const store = memoryStore();
    const approvals = createInClientApprovals(store);
    const lifecycle = createReviewLifecycle({
      store,
      baselines: [reviewedBaseline],
      approvals,
      history: { documents: async () => [] },
    });
    const app = doc("transfer-panel");
    await seedAppRow(store, app, owner.principal.subject);
    // An approval exists, but for a version no history snapshot can vouch for.
    await approvals.record({
      appId: app.id,
      versionHash: "sha256:gone-from-history",
      approvedBy: "host-console",
      at: "2026-08-01T13:00:00.000Z",
    });
    expect(await lifecycle.serveDocFor(app)).toEqual(app);
    expect(await lifecycle.venueStateFor(app)).toMatchObject({
      granted: false,
      reason: "pending-review",
    });
  });
});

describe("rejection", () => {
  it("requires a note", async () => {
    const { store, runtime } = setup();
    const app = doc("transfer-panel");
    await seedAppRow(store, app, owner.principal.subject);
    await expect(runtime.review.reject({ appId: app.id, note: "   " }, reviewer))
      .rejects.toMatchObject({ code: "validation" });
  });

  it("refuses on a non-review-kind app, an approved version, and an unknown app", async () => {
    const { store, runtime } = setup();
    const instant = doc("hero-card");
    await seedAppRow(store, instant, owner.principal.subject);
    await expect(runtime.review.reject({ appId: instant.id, note: "no" }, reviewer))
      .rejects.toMatchObject({ code: "conflict" });

    const reviewed = doc("transfer-panel");
    await seedAppRow(store, reviewed, owner.principal.subject);
    await runtime.inClient.approve({ appId: reviewed.id, approvedBy: "host-console" }, owner);
    await expect(runtime.review.reject({ appId: reviewed.id, note: "too late" }, reviewer))
      .rejects.toMatchObject({ code: "conflict" });

    await expect(runtime.review.reject({ appId: "app_missing", note: "no" }, reviewer))
      .rejects.toMatchObject({ code: "not-found" });
  });

  it("records the note, surfaces it to the user, drops the version from the queue, and audits under the owner", async () => {
    const { store, guard, runtime } = setup();
    const app = doc("transfer-panel");
    await seedAppRow(store, app, owner.principal.subject);

    expect(await runtime.review.queue()).toHaveLength(1);

    const rejection = await runtime.review.reject(
      { appId: app.id, note: "Keep the original balance label." },
      reviewer,
    );
    expect(rejection).toMatchObject({
      appId: app.id,
      versionHash: appVersionHash(app),
      note: "Keep the original balance label.",
      by: reviewer.principal.subject,
    });

    // The queue drops it; the work is NOT deleted.
    expect(await runtime.review.queue()).toEqual([]);
    expect(await runtime.get(app.id, owner)).not.toBeNull();

    // The note rides the venue state the user's panel reads.
    const surface = await runtime.open(app.id, owner);
    if (surface.kind !== "tree") throw new Error("expected tree surface");
    expect((surface.payload as { inClient?: unknown }).inClient).toMatchObject({
      granted: false,
      reason: "pending-review",
      review: {
        status: "rejected",
        versionHash: appVersionHash(app),
        note: "Keep the original balance label.",
        by: reviewer.principal.subject,
      },
    });

    // The audit event lands under the OWNER's subject — the rejection is loud
    // in the remixing user's activity, not the reviewer's.
    expect(guard.audit.some((event) =>
      event.kind === "app-lifecycle"
      && event.principal.subject === owner.principal.subject
      && event.detail?.operation === "review-reject"
      && event.detail?.note === "Keep the original balance label.")).toBe(true);
  });

  it("a new version supersedes the rejection and increments the resubmission count", async () => {
    const { store, runtime } = setup();
    const app = doc("transfer-panel");
    await seedAppRow(store, app, owner.principal.subject);
    await runtime.review.reject({ appId: app.id, note: "Not like this." }, reviewer);
    expect(await runtime.review.queue()).toEqual([]);

    const edited = await runtime.edit(app.id, "Rename it", owner);
    expect(edited.failure).toBeUndefined();

    const queue = await runtime.review.queue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      appId: app.id,
      versionHash: appVersionHash(edited.app),
      resubmissions: 1,
    });
    // Pending again — the old note no longer speaks for the new version.
    const surface = await runtime.open(app.id, owner);
    if (surface.kind !== "tree") throw new Error("expected tree surface");
    expect((surface.payload as { inClient?: { review?: { status?: string } } }).inClient?.review?.status).toBe("pending");
  });

  it("delete clears the app's rejection records", async () => {
    const { store, runtime } = setup();
    const app = doc("transfer-panel");
    await seedAppRow(store, app, owner.principal.subject);
    await runtime.review.reject({ appId: app.id, note: "Nope." }, reviewer);
    await runtime.delete(app.id, owner);
    expect((await store.records("vendo_remix_rejections").list({ refs: { appId: app.id } })).records).toEqual([]);
  });
});

describe("review queue", () => {
  it("lists pending review-kind versions with requester, slot, hash, submission time, resubmissions and the ship-diff", async () => {
    const { store, runtime } = setup();
    const app = doc("transfer-panel");
    await seedAppRow(store, app, owner.principal.subject);

    const queue = await runtime.review.queue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      appId: app.id,
      requester: owner.principal.subject,
      slot: "transfer-panel",
      versionHash: appVersionHash(app),
      resubmissions: 0,
    });
    expect(queue[0]?.submittedAt).toEqual(expect.any(String));
    expect(queue[0]?.shipDiff).toMatchObject({
      appId: app.id,
      versionHash: appVersionHash(app),
      pins: [{ slot: "transfer-panel" }],
    });
    expect(queue[0]?.shipDiff.pins[0]?.diff).toContain("+export default function Fork() { return <b>fork</b>; }");
  });

  it("never lists instant-kind apps or approved review-kind versions", async () => {
    const { store, runtime } = setup();
    const instant = doc("hero-card");
    await seedAppRow(store, instant, owner.principal.subject);
    expect(await runtime.review.queue()).toEqual([]);

    const reviewed = doc("transfer-panel");
    await seedAppRow(store, reviewed, owner.principal.subject);
    expect(await runtime.review.queue()).toHaveLength(1);
    await runtime.inClient.approve({ appId: reviewed.id, approvedBy: "host-console" }, owner);
    expect(await runtime.review.queue()).toEqual([]);
  });
});
