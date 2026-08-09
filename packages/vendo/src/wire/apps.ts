import { VendoError, type AccessLevel, type Json, type RunContext } from "@vendoai/core";
import type { VendoStore } from "@vendoai/store";
import { json, requestJson, route, string, type RouteEntry, type WireContext } from "./shared.js";

/** Build contract §9.3 — the level vocabulary is CLOSED, so the wire refuses
    anything outside it instead of letting a typo reach the store. */
function accessLevel(value: unknown): AccessLevel {
  const level = string(value, "level");
  if (level !== "viewer" && level !== "editor" && level !== "owner") {
    throw new VendoError("validation", "level must be viewer, editor, or owner");
  }
  return level;
}

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

    The read goes through the ADAPTER interface (store.records), never
    appStore(): appStore speaks raw SQL over a local db handle, which a
    hosted wire-door store doesn't have — through it this probe answered
    false on every Cloud-hosted-store deployment, so every owner-scoped
    not-found masked to {kind:"pending"} and the #532 terminal records never
    reached the embed (defect D2). The only document content that leaves this
    check is the buildFailed marker, which is server-written by construction
    (runtime.create strips any model-emitted buildFailed): canned reasons,
    never user content. A store that still can't answer keeps the pending
    window. */
async function probeUnownedAppRecord(store: VendoStore, appId: string): Promise<UnownedAppProbe> {
  try {
    const record = await store.records("vendo_apps").get(appId);
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

/** Existing-agents polish — the embed's build-window poll. The app record
    lands only at build completion, so until then open() (and the meta
    route alike) answers not-found, and every 1.2s poll logged a browser
    console 404. Under the additive ?pending=1 flag, ONLY that expected
    pre-servable miss becomes a quiet 200 {kind:"pending"}; unflagged
    callers keep the contracted 404, and every other failure keeps its
    envelope and status either way. A record that DOES exist — just not
    for this caller — is not a build in progress and never will be: that
    answers the terminal failed vocabulary (with the principal-mismatch
    diagnosis) so the embed resolves promptly instead of skeleton-polling
    to its deadline (0.4.1 E2E cert B4). */
async function openWithPendingWindow(wire: WireContext, appId: string, ctx: RunContext): Promise<Response> {
  const { deps } = wire;
  try {
    return json(await deps.apps.open(appId, ctx));
  } catch (reason) {
    if (!(reason instanceof VendoError && reason.code === "not-found")) throw reason;
    // Build contract §9.4 — the probe is a DIAGNOSTIC for a caller who
    // can already see the app, never a lookup for one who cannot. It
    // reads UNSCOPED rows, so running it for a non-viewer made
    // `?pending=1` an existence oracle: any stranger with an app id
    // learned whether a team app was real, at HTTP 200, while the same
    // request without the flag correctly 404'd. A non-viewer now gets
    // exactly what a non-existent app gets.
    const probe = await probeUnownedAppRecord(deps.store, appId);
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

async function handleHistory(wire: WireContext, appId: string, ctx: RunContext): Promise<Response | undefined> {
  const { request, deps } = wire;
  // The door still masks an app this caller cannot see at all.
  if (await deps.apps.get(appId, ctx) === null) throw new VendoError("not-found", `app not found: ${appId}`);
  if (request.method === "GET") return json(await deps.apps.history(appId, ctx).list());
  return undefined;
}

/** Owner-gated on purpose: whoever may ask this may enumerate the host's own
    directory, so the gate is the same one that writes the grant. A caller who
    cannot see the app at all stays masked (§9.4). */
async function resolvePersonForShare(wire: WireContext, appId: string, ctx: RunContext): Promise<Response> {
  const { request, deps } = wire;
  const level = await deps.apps.access.levelFor(appId, ctx);
  if (level === null) throw new VendoError("not-found", `app not found: ${appId}`);
  if (level !== "owner") throw new VendoError("forbidden", `owner access is required for ${appId}`);
  // ...and an owner with NO asserted org, on top of that. A person-share
  // implies an org workspace (§9.5), so a caller in no org can never complete
  // the share this lookup exists for — answering them is nothing but
  // directory exposure. A signed-in stranger probing from their own personal
  // app was handed the host's real subjects and display names at HTTP 200.
  if ((ctx.memberships ?? []).length === 0) {
    throw new VendoError(
      "forbidden",
      `no org is asserted for this caller, so a person-share on ${appId} could never be completed`,
    );
  }
  if (deps.resolvePerson === undefined) {
    throw new VendoError(
      "not-implemented",
      "sharing with one person needs the auth preset's `resolvePerson` seam:"
      + " Vendo has no directory, so only your identity system can turn a typed"
      + " name into one of your subjects",
    );
  }
  const body = await requestJson(request);
  // The asker rides along: only the host knows which part of its own
  // directory this person may see.
  return json({ person: await deps.resolvePerson(string(body["query"], "query"), ctx.principal) });
}

async function handleGrants(wire: WireContext, appId: string, ctx: RunContext): Promise<Response | undefined> {
  const { request, deps } = wire;
  if (request.method === "GET") {
    return json({
      level: await deps.apps.access.levelFor(appId, ctx),
      grants: await deps.apps.access.list(appId, ctx),
      // §9.5 — "share implies promote" needs to know whether this is still
      // the caller's own copy. Derived from who HOLDS the row, so the
      // dialog never has to guess from an empty grant list.
      personal: await deps.apps.access.holder(appId, ctx) === ctx.principal.subject,
    });
  }
  if (request.method === "POST") {
    const body = await requestJson(request);
    await deps.apps.access.grant(
      appId,
      string(body["principal"], "principal"),
      accessLevel(body["level"]),
      ctx,
    );
    return json({ grants: await deps.apps.access.list(appId, ctx) });
  }
  if (request.method === "DELETE") {
    const principal = wire.url.searchParams.get("principal");
    await deps.apps.access.revoke(appId, string(principal, "principal"), ctx);
    // The revoke LANDED. Reading the list back is a courtesy for the dialog,
    // and a caller who just removed their OWN last grant may no longer read
    // it — that is §9.4's masking answering a different question, not a
    // failed removal, and reporting it as one told them to retry work that
    // was already done. Answer with what they can still legitimately see:
    // nothing.
    //
    // Only `can()` may be forgiven here, and `can()` always refuses with a
    // VendoError — so the TYPE is half the test. A hosted store carries a
    // misbehaving console's failure on a plain Error with the server's code
    // attached (hosted-store.ts), and "the console said not-found" is not
    // "the caller may no longer look": that, and every other failure,
    // surfaces.
    const remaining = await deps.apps.access.list(appId, ctx).catch((reason: unknown) => {
      const masked = reason instanceof VendoError
        && (reason.code === "not-found" || reason.code === "forbidden");
      if (masked) return [];
      throw reason;
    });
    return json({ grants: remaining });
  }
  return undefined;
}

/** Every operation arm in the table below asks the same three-part question:
    this method, this operation segment, exactly this many segments. Naming it
    once keeps an arm's SHAPE the thing you read, instead of thirteen
    repetitions of the triple. */
const op = (wire: WireContext, method: string, operation: string, length = 3): boolean =>
  wire.request.method === method && wire.segments[2] === operation && wire.segments.length === length;

/** 06-apps / 09 §3 — the /apps wire area: CRUD, open/call/edit, history,
    ship-diff, pin drift/rebase, the gesture fork (fork-pin), export/import,
    fork (whole-app copy — a different feature from fork-pin). */
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
  // 06-apps §8 — gesture-owned forking (2026-07-21): the deterministic fork
  // the user's Remix gesture on an EMPTY slot invokes. The engine mints a
  // minimal app, copies the captured baseline, and records the pin — no model
  // call. An optional instruction then rides the ordinary edit path, already
  // scoped to the forked component. The model never decides to fork.
  // ORDER IS LOAD-BEARING: this entry (and /apps/import below) must stay
  // ahead of the "/apps/:appId/*" catch-all, whose rest pattern would
  // otherwise capture appId="fork-pin".
  route("POST", "/apps/fork-pin", async ({ request, deps, context }) => {
    const ctx = await context("app");
    const body = await requestJson(request);
    // 2026-08-02 final shape — `props` is the wrapper's serializable live
    // props at fork time, stored on the fork as its dashboard seed.
    const props = body["props"];
    if (props !== undefined && (typeof props !== "object" || props === null || Array.isArray(props))) {
      throw new VendoError("validation", "props must be an object");
    }
    return json(await deps.apps.pins.fork({
      slot: string(body["slot"], "slot"),
      ...(props === undefined ? {} : { props: props as Record<string, Json> }),
      ...(body["instruction"] === undefined ? {} : { instruction: string(body["instruction"], "instruction") }),
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
  // Like fork-pin above, this entry must stay ahead of the "/apps/:appId/*"
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
  // ORDER IS LOAD-BEARING, exactly like /apps/fork-pin above: the
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
      return json(await deps.apps.open(appId, ctx));
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
    // 06-apps §8 — additive rebase surface. A rebase rewrites content and is
    // editor-scoped; the runtime owns the level. It is only ever invoked
    // explicitly here or via the vendo_apps_rebase_pin agent tool — the drift
    // report open() carries never auto-rebases.
    if (op(wire, "POST", "rebase-pin")) {
      const body = await requestJson(request);
      return json(await deps.apps.pins.rebase({ appId, slot: string(body["slot"], "slot") }, ctx));
    }
    // 06-apps §8 — the same gesture fork landing in an EXISTING app (the
    // filled-slot / driver surface). Editor-scoped: it lands a change.
    if (op(wire, "POST", "fork-pin")) {
      const body = await requestJson(request);
      return json(await deps.apps.pins.fork({
        appId,
        slot: string(body["slot"], "slot"),
        ...(body["instruction"] === undefined ? {} : { instruction: string(body["instruction"], "instruction") }),
      }, ctx));
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
    // Build contract §9.1 companion — the host names the person. Vendo holds no
    // directory, so the dialog cannot resolve "Mia" and must not pretend to; it
    // asks here, and the grant is written for the SUBJECT that comes back.
    //
    // Owner-gated on purpose: whoever may ask this may enumerate the host's own
    // directory, so the gate is the same one that writes the grant. A caller who
    // cannot see the app at all stays masked (§9.4).
    if (op(wire, "POST", "grants", 4) && segments[3] === "resolve") {
      return resolvePersonForShare(wire, appId, ctx);
    }
    // Build contract §9.2–§9.6 — the Share dialog's door. Reading the grant
    // list is viewer-gated and OSS; writing one is owner-gated AND
    // Cloud-gated, and the runtime (not this route) is where both are decided,
    // so the MCP door inherits the same rules without a second copy.
    if (operation === "grants" && segments.length === 3) {
      const answer = await handleGrants(wire, appId, ctx);
      if (answer !== undefined) return answer;
    }
    if (op(wire, "POST", "promote")) {
      const body = await requestJson(request);
      return json(await deps.apps.promote(appId, string(body["orgId"], "orgId"), ctx));
    }
    return undefined;
  }),
];
