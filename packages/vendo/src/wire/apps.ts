import { VendoError, type Json, type RunContext, type StoreOps } from "@vendoai/core";
import { json, requestJson, route, string, type RouteEntry, type WireContext } from "./shared.js";

/** What the ?pending=1 disambiguation learned about a record open() refused
    to serve this caller. */
interface UnownedAppProbe {
  exists: boolean;
  /** The server-written terminal marker (#532), when the record carries one. */
  buildFailed?: { reason: string; retryable?: boolean };
}

/** Unscoped probe behind the ?pending=1 disambiguation: does ANY principal
    own a record with this id, and did its build terminally fail? Owner-scoped
    open() answers not-found for "still building", "exists under someone
    else", AND "terminally failed under another subject" alike — and masking
    the latter two as pending is the infinite skeleton (0.4.1 E2E cert B4;
    0.4.6 cert defect D2).

    The read goes through the named-operation surface (ops.engine), never
    appStore(): appStore speaks raw SQL over a local db handle, which a
    hosted wire-door store doesn't have — through it this probe answered
    false on every Cloud-hosted-store deployment, so every owner-scoped
    not-found masked to {kind:"pending"} and the #532 terminal records never
    reached the embed (defect D2). The only document content that leaves this
    check is the buildFailed marker, which is server-written by construction
    (runtime.create strips any model-emitted buildFailed): canned reasons,
    never user content. A store that still can't answer — including one with no
    ops surface at all — keeps the pending window. */
async function probeUnownedAppRecord(
  ops: StoreOps | undefined,
  appId: string,
): Promise<UnownedAppProbe> {
  if (ops === undefined) return { exists: false };
  try {
    const record = await ops.engine.get("vendo_apps", appId);
    if (record === null) return { exists: false };
    const doc = (record.data as { doc?: { buildFailed?: { reason?: unknown; retryable?: unknown } } } | null)?.doc;
    const failed = doc?.buildFailed;
    if (typeof failed?.reason === "string") {
      return {
        exists: true,
        buildFailed: {
          reason: failed.reason,
          ...(typeof failed.retryable === "boolean" ? { retryable: failed.retryable } : {}),
        },
      };
    }
    return { exists: true };
  } catch {
    return { exists: false };
  }
}

/** One slot id out of the comma-separated `?slots=` list. Each id is
 *  percent-encoded on its OWN before the join (`client-impl.ts` slotsQuery), so
 *  a "," that belongs to a slot id can never read as the separator. Text that
 *  is not valid percent-encoding is a hand-written URL and stands for itself. */
function decodeSlot(slot: string): string {
  try {
    return decodeURIComponent(slot);
  } catch {
    return slot;
  }
}

/** Existing-agents polish — the embed's build-window poll. A screen's record
    lands at its FIRST painting save and carries `building` until the assembler
    returns, so open() (and the meta route alike) answers not-found for the whole
    build either way — no row at first, then a row still being written — and
    every 1.2s poll logged a browser console 404. Under the additive
    ?pending=1 flag, ONLY that expected
    pre-servable miss becomes a quiet 200 {kind:"pending"}; unflagged
    callers keep the contracted 404, and every other failure keeps its
    envelope and status either way. A record that DOES exist — just not
    for this caller — is not a build in progress and never will be: that
    answers the terminal failed vocabulary (with the principal-mismatch
    diagnosis) so the embed resolves promptly instead of skeleton-polling
    to its deadline (0.4.1 E2E cert B4). */
/**
 * Arrival bookkeeping, which is TELEMETRY: it records that a person's render
 * happened, and nothing they see may depend on it. `seen` re-checks access
 * (`apps-surface.ts`), so it can throw `not-found` — and in the response's
 * success path that throw BECAME the answer: a served 200 turning into a 404,
 * and, inside the pending window's `catch`, a successfully served tree silently
 * reported as `{kind:"pending"}` while the embed polled forever.
 *
 * So a failed mark is dropped, here and at every call site. This is the only
 * swallow in this file, and it is sound for one narrow reason: what is dropped is
 * not part of the answer, and its absence costs a dot that clears one render
 * later.
 */
const markArrival = async (deps: WireContext["deps"], appId: string, ctx: RunContext): Promise<void> => {
  await deps.apps.seen(appId, ctx).catch(() => {});
};

/** The ?pending=1 not-found disambiguation. Lifted out of the `catch` it used to
 *  be the whole body of, so that arm guards nothing but the open itself and no
 *  later failure can be mistaken for the open's own not-found. */
async function answerUnservableApp(wire: WireContext, appId: string, ctx: RunContext): Promise<Response> {
  const { deps } = wire;
  {
    // Build contract §9.4 — the probe is a DIAGNOSTIC for a caller who
    // can already see the app, never a lookup for one who cannot. It
    // reads UNSCOPED rows, so running it for a non-viewer made
    // `?pending=1` an existence oracle: any stranger with an app id
    // learned whether a team app was real, at HTTP 200, while the same
    // request without the flag correctly 404'd. A non-viewer now gets
    // exactly what a non-existent app gets.
    const probe = await probeUnownedAppRecord(deps.ops, appId);
    if (await deps.apps.access.levelFor(appId, ctx) === null) {
      // The principal-mismatch diagnosis (0.4.1 E2E cert B4) is a HOST
      // wiring problem in a developer's voice, so it keeps its signal
      // where only the host reads it — the server log — instead of
      // being served to whoever asked.
      if (probe.exists) {
        console.warn(
          `[vendo] GET /apps/${appId}/open answered not-found, but a record with that id `
          + "exists under another subject: this wire route's principal must resolve the same "
          + "subject your agent loop uses (see docs.vendo.run/existing-agents)",
        );
      }
      return json({ kind: "pending" });
    }
    // A terminal build failure is terminal for EVERY caller: pass the
    // server-written reason through instead of masking it as a build
    // still in progress (0.4.6 cert defect D2).
    if (probe.buildFailed !== undefined) {
      return json({
        kind: "failed",
        reason: probe.buildFailed.reason,
        ...(probe.buildFailed.retryable === undefined ? {} : { retryable: probe.buildFailed.retryable }),
      });
    }
    // This caller CAN see the app (checked above) and it carries no
    // terminal marker, so "still building" is the honest answer. The
    // principal-mismatch diagnosis that used to live here belongs to the
    // non-viewer branch, where it is now logged for the host instead of
    // served to the caller.
    return json({ kind: "pending" });
  }
}

async function openWithPendingWindow(wire: WireContext, appId: string, ctx: RunContext): Promise<Response> {
  const { deps } = wire;
  // The ONLY thing this arm guards is the open. The flag rides through to the
  // runtime, which answers a build still in flight with `{kind:"pending"}` plus —
  // when the draft paints — the forming tree's geometry, so the embed's poll has
  // something to show.
  let surface: Awaited<ReturnType<typeof deps.apps.open>>;
  try {
    surface = await deps.apps.open(appId, ctx, { pending: true });
  } catch (reason) {
    if (!(reason instanceof VendoError && reason.code === "not-found")) throw reason;
    return await answerUnservableApp(wire, appId, ctx);
  }
  // Arrival, outside that catch on purpose — a mark's own not-found must never be
  // read as the open's. A `pending` answer put nothing on screen (the whole point
  // of the flag), so it is not a render; the opener's build-window decision is the
  // gate, and nothing re-reads `building` to guess at it.
  if (surface.kind !== "pending") await markArrival(deps, appId, ctx);
  return json(surface);
}

async function handleHistory(wire: WireContext, appId: string, ctx: RunContext): Promise<Response | undefined> {
  const { request, deps } = wire;
  // The door still masks an app this caller cannot see at all.
  if (await deps.apps.get(appId, ctx) === null) throw new VendoError("not-found", `app not found: ${appId}`);
  if (request.method === "GET") return json(await deps.apps.history(appId, ctx).list());
  return undefined;
}

/** Every operation arm in the table below asks the same three-part question:
    this method, this operation segment, exactly this many segments. Naming it
    once keeps an arm's SHAPE the thing you read, instead of thirteen
    repetitions of the triple. */
const op = (wire: WireContext, method: string, operation: string, length = 3): boolean =>
  wire.request.method === method && wire.segments[2] === operation && wire.segments.length === length;

/** 06-apps / 09 §3 — the /apps wire area: CRUD, open/call/edit, history,
    ship-diff, seed drift/re-seed, the ✦ gesture (seed), export/import,
    fork (whole-app copy — a different feature from seeding). */
export const appRoutes: RouteEntry[] = [
  // Grouped like the old if-chain arm: ANY method on /apps resolves context
  // first; an unhandled method falls through to the table's not-found.
  route("*", "/apps", async ({ request, deps, context }) => {
    const ctx = await context("app");
    if (request.method === "GET") {
      return json(await deps.apps.list(ctx));
    }
    if (request.method === "POST") {
      const body = await requestJson(request);
      return json(await deps.apps.create({ prompt: string(body["prompt"], "prompt") }, ctx));
    }
    return undefined;
  }),
  // 06-apps §8 — the ✦ gesture: the remix the user's Remix gesture invokes.
  // There are no bare forks — the gesture collects the instruction first, and
  // the runtime mints an app carrying the remix's provenance and then runs that
  // instruction through the ordinary edit door, as ONE operation.
  // ORDER IS LOAD-BEARING: this entry (and /apps/import below) must stay
  // ahead of the "/apps/:appId/*" catch-all, whose rest pattern would
  // otherwise capture appId="seed".
  route("POST", "/apps/seed", async ({ request, deps, context }) => {
    const ctx = await context("app");
    const body = await requestJson(request);
    return json(await deps.apps.seed.from({
      component: string(body["component"], "component"),
      instruction: string(body["instruction"], "instruction"),
      ...(body["slot"] === undefined ? {} : { slot: string(body["slot"], "slot") }),
    }, ctx));
  }),
  // Remix final shape (2026-08-02) — the review seam for the host's console:
  // every review-kind version awaiting a reviewer, with requester, slot,
  // version hash, submission time, resubmission count and the ship-diff
  // payload. It crosses owner boundaries, so it carries the FULL scoping of
  // the in-client approval seam (wire/misc.ts): a development composition AND
  // a host-resolved principal — reviewing is a HOST trust decision, and no
  // wire surface may expose one subject's pending fork source to another.
  // Even in dev the cross-owner read requires the composition's reviewer
  // assertion (apps.review.reviewer, enforced by the runtime); without it a
  // caller sees only their own submissions, and any other caller gets an
  // EMPTY queue — masked, never a probe. Production reviews ride Cloud's
  // console, or the self-hoster's own admin-authenticated route over the
  // runtime surface (apps.review).
  // Like /apps/seed above, this entry must stay ahead of the "/apps/:appId/*"
  // catch-all, whose rest pattern would otherwise capture
  // appId="review-queue".
  route("GET", "/apps/review-queue", async ({ deps, context }) => {
    const ctx = await context("app");
    if (!deps.development || ctx.principal.ephemeral === true) return json([]);
    // Round-2 hardening: the runtime scopes the answer — the FULL queue only
    // under the host's reviewer assertion (apps.review.reviewer); any other
    // host-resolved caller sees just their own submissions.
    return json(await deps.apps.review.queue(ctx));
  }),
  // Placement (2026-08-05) — the slots' own read: what is in each of the
  // caller's mounted slots, and where each of those builds stands. ONE request
  // for every slot on the page, which is why the slot list is a query param.
  // ORDER IS LOAD-BEARING, exactly like /apps/seed above: the
  // "/apps/:appId/*" catch-all would otherwise capture appId="placements".
  route("GET", "/apps/placements", async ({ url, deps, context }) => {
    const ctx = await context("app");
    const slots = (url.searchParams.get("slots") ?? "")
      .split(",")
      .map((slot) => decodeSlot(slot.trim()))
      .filter((slot) => slot.length > 0);
    return json(await deps.apps.placements(slots.length === 0 ? {} : { slots }, ctx));
  }),
  route("POST", "/apps/import", async ({ request, deps, context }) => {
    // The CSRF floor exempts import (binary body), so it must instead require
    // a non-CORS-safelisted media type — forcing a cross-origin preflight so
    // a simple credentialed form/text POST cannot silently import (09 §3).
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/octet-stream" && contentType !== "application/vnd.vendo.app") {
      throw new VendoError("validation", "import requires Content-Type: application/octet-stream");
    }
    const ctx = await context("app");
    return json(await deps.apps.importApp(new Uint8Array(await request.arrayBuffer()), ctx));
  }),
  // The old `head === "apps" && segments.length >= 2` grouped arm, verbatim:
  // context resolves for ANY /apps/:appId[/...] request before the method and
  // operation checks, and an unmatched combination falls through to not-found.
  route("*", "/apps/:appId/*", async (wire) => {
    const { request, deps, params, segments } = wire;
    const appId = string(params["appId"], "app id");
    const ctx = await wire.context("app");
    const operation = segments[2];
    if (segments.length === 2) {
      if (request.method === "GET") {
        const app = await deps.apps.get(appId, ctx);
        if (app === null) throw new VendoError("not-found", `app not found: ${appId}`);
        return json(app);
      }
      if (request.method === "DELETE") {
        await deps.apps.delete(appId, ctx);
        return json({});
      }
    }
    if (op(wire, "GET", "open")) {
      if (wire.url.searchParams.get("pending") === "1") return openWithPendingWindow(wire, appId, ctx);
      const surface = await deps.apps.open(appId, ctx);
      // Arrival — THIS is what "rendering marks it seen" means: a person's
      // browser asked for a surface to put on screen. The runtime door is not
      // the place for it (an agent's `vendo_apps_open` and an automation both
      // pass through there); a build still in flight never reaches this line,
      // because open() answers not-found until it can serve. Non-fatal: the
      // surface is already served, and bookkeeping does not get to unserve it.
      await markArrival(deps, appId, ctx);
      return json(surface);
    }
    if (op(wire, "POST", "call")) {
      const body = await requestJson(request);
      return json(await deps.apps.call(appId, string(body["ref"], "ref"), body["args"] as Json, ctx));
    }
    if (op(wire, "POST", "edit")) {
      const body = await requestJson(request);
      return json(await deps.apps.edit(appId, string(body["instruction"], "instruction"), ctx));
    }
    // Build contract §9.3 — the LEVEL lives in the runtime: `list` needs
    // viewer, and a caller who cannot see the app stays masked. This route just
    // names the caller; it is no longer the only thing standing between a
    // viewer and the team's history.
    if (operation === "history" && segments.length === 3) {
      const answer = await handleHistory(wire, appId, ctx);
      if (answer !== undefined) return answer;
    }
    // 06-apps §8–§9 — additive: the reviewable diff of what this app ships
    // relative to the captured host baselines, hash-pinned to the version
    // an in-client approval would cover. Viewer-scoped: reading what a shared
    // app ships is part of seeing it (the runtime owns the level, as ever).
    if (op(wire, "GET", "ship-diff")) {
      return json(await deps.apps.inClient.shipDiff(appId, ctx));
    }
    // 06-apps §8 — the re-seed. It rewrites content and is editor-scoped; the
    // runtime owns the level. Only ever invoked explicitly, here or via the
    // vendo_apps_reseed agent tool — the drift warning open() carries never
    // acts on its own, because acting means replacing what the person made.
    if (op(wire, "POST", "reseed")) {
      return json(await deps.apps.seed.reseed({ appId }, ctx));
    }
    // Placement (2026-08-05) — one app per slot. The level lives in the
    // runtime (viewer: putting an app you can see into your own slot), and
    // `evicted` names whatever held the slot before.
    if (op(wire, "POST", "place")) {
      const body = await requestJson(request);
      return json(await deps.apps.place({ app: appId, slot: string(body["slot"], "slot") }, ctx));
    }
    if (op(wire, "POST", "unplace")) {
      const body = await requestJson(request);
      await deps.apps.unplace({ app: appId, slot: string(body["slot"], "slot") }, ctx);
      return json({});
    }
    // Remix final shape (2026-08-02) — the reviewer's rejection of the app's
    // CURRENT review-kind version: the note is REQUIRED (it is what the
    // user's panel surfaces) and the work is not deleted — a new version
    // supersedes the rejection. Reviewer-side and cross-subject by design,
    // so it carries the review queue's full scoping (development composition
    // + host-resolved principal + the composition's reviewer assertion,
    // enforced by the runtime: without apps.review.reviewer the reject
    // refuses, naming the hook) instead of owner scoping; any other caller
    // gets the same not-found an unowned app answers (masked).
    if (op(wire, "POST", "reject-review")) {
      if (!deps.development || ctx.principal.ephemeral === true) {
        throw new VendoError("not-found", `app not found: ${appId}`);
      }
      const body = await requestJson(request);
      return json(await deps.apps.review.reject({ appId, note: string(body["note"], "note") }, ctx));
    }
    // Wave 7 H2 — the embed surface's keepalive: user activity on an embedded
    // served app rides one host-proxied HEAD through the machine (re-arming
    // the idle timer); "woke" tells the embed its URL is stale — re-open.
    if (op(wire, "POST", "machine", 4) && segments[3] === "ping") {
      return json(await deps.apps.machine.ping(appId, ctx));
    }
    if (op(wire, "GET", "export")) {
      const bytes = await deps.apps.exportApp(appId, ctx);
      return new Response(bytes as BodyInit, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${appId}.vendoapp"`,
        },
      });
    }
    if (op(wire, "POST", "fork")) {
      return json(await deps.apps.fork(appId, ctx));
    }
    return undefined;
  }),
];
