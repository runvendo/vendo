/**
 * FINAL SPEC v1 — the built-app door: `AppsRuntime.build`, plus the resume hook
 * the decision seam fires into and the seal the build lane lands through.
 *
 * The law it exists to keep: no machine is ever spent without the user's
 * explicit yes. `propose` raises the standing approval card and RETURNS —
 * nothing here waits on it, because the yes may arrive long after the turn that
 * asked is gone — and `resume` is the ONLY path from that yes to the builder.
 * Between the two, the app row says "offered, unanswered" and no box exists.
 */
import {
  VENDO_APP_BUILD_TOOL,
  VENDO_APP_FORMAT,
  VENDO_TOOL_NOTES,
  VENDO_TOOL_TITLES,
  VendoError,
  type AppBuildProposal,
  type AppBundle,
  type AppId,
  type ApprovalId,
  type PendingApproval,
  type RunContext,
  type ToolCall,
  type ToolDescriptor,
} from "@vendoai/core";
import type { BuiltFile } from "../../contract/index.js";
import {
  BUILD_ALREADY_ASKED,
  BUILD_DECLINED,
  BUILD_WATCHDOG_REASON,
  NO_MACHINE,
  buildWatchdogMs,
  fallbackAppName,
} from "./build-messages.js";
import { readBundleBlob, sealBundleBlobs } from "../persistence/app-source.js";
import { APPS_COLLECTION, appRecordInput } from "../persistence/persistence.js";
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";
import type { AppsRuntime } from "../runtime/types.js";

/**
 * Spending a build machine is the person's call, so the ask is the ordinary
 * high-risk one: a `confirmEach` descriptor through `guard.check`, which parks
 * an approval and hands back its card. The card STANDS — this door never waits
 * on it, so the harness's 90-second approval wait is not in this path at all.
 */
const BUILD_TOOL = VENDO_APP_BUILD_TOOL;
// §3 consumer voice — the shared table, like every other Vendo descriptor.
// Without it the card asked the person to authorize "Vendo app build".
const BUILD_TITLE = VENDO_TOOL_TITLES[BUILD_TOOL]!;
const BUILD_DESCRIPTION = VENDO_TOOL_NOTES[BUILD_TOOL]!;

/** This ask in words, for the surfaces that render no card. Both halves come
 *  from the shared core tables, which is what makes this the SAME ask the card
 *  shows: `consentAsk` (ui/chrome/build-beat.tsx) reads them too, because
 *  ruling 14 keeps the descriptor's own sentence off the consent ladder. */
export const BUILD_CONSENT_ASK: Omit<PendingApproval, "id"> = {
  question: `${BUILD_TITLE}?`,
  notes: [BUILD_DESCRIPTION],
};

/** The descriptor the guard parks the ask on. Its `description` is the MODEL's
 *  copy of the same sentence; the words a person reads reach the card through
 *  `VENDO_TOOL_NOTES`, never through here. */
export const buildDescriptor = (): ToolDescriptor => ({
  name: BUILD_TOOL,
  title: BUILD_TITLE,
  description: BUILD_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: { appId: { type: "string" }, prompt: { type: "string" } },
    required: ["appId", "prompt"],
  },
  risk: "write",
  confirmEach: true,
});
/** Stable across the park/decide phases, like the egress lane's, so the guard's
 *  approved-replay match lines up. */
const buildCall = (appId: AppId, prompt: string): ToolCall => ({
  id: `call_build_${appId}`,
  tool: BUILD_TOOL,
  args: { appId, prompt },
});

export interface SealInput {
  appId: AppId;
  files: readonly BuiltFile[];
  entry: string;
  /** The version this reseal started from, recorded on the history entry. */
  base?: string;
}

/**
 * THE ENFORCER a sealed bundle renders behind, and the reason the frame needs no
 * trust: `default-src 'none'` is zero network — the bundle was sealed with
 * everything it needs, so it has nothing to fetch and nowhere to phone home to.
 * The two `'unsafe-inline'`s are what let the document carry its own script and
 * styles at all, which is the point: nothing is loaded, so nothing can be
 * injected from outside.
 *
 * `font-src data:` is `img-src`'s trade, made twice for the same reason: brand
 * fonts are injected AT RENDER as `data:` faces (`sendFrameTheme`), and a data
 * URI is inline — it costs no request, so the zero-network guarantee is
 * untouched. A scheme or an origin here would hand that guarantee back.
 *
 * It is a HEADER and never a `<meta>` tag, because `frame-ancestors` — the half
 * that says only the host's own page may frame this — is ignored in meta.
 */
export const BUNDLE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';"
  + " img-src data:; font-src data:; frame-ancestors 'self'";

export const BUNDLE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": BUNDLE_CSP,
  // The url IS the content's hash, so these bytes can never become stale.
  // `private` because the answer is viewer-scoped: a shared cache must not hand
  // one person's app to the next request for the same url.
  "cache-control": "private, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The frame's whole document: the sealed entry INLINE, and nothing else to
 * fetch. Brand tokens and fonts are not in here — they arrive by postMessage at
 * render (`sendFrameTheme`), so one seal follows the host's palette instead of
 * pinning the palette it was built under.
 */
export function bundleDocument(entry: Uint8Array): Uint8Array {
  // A bundle carries markup in its own strings, and a raw `</script` inside an
  // inline script ends the script early — the app that renders HTML snippets
  // would ship broken.
  // Case-insensitively, because the HTML parser matches an end tag that way
  // (HTML5 §13.2.6.4) — and the tag's own case is KEPT, because the escape
  // lands inside a JavaScript string literal the app renders verbatim.
  const script = decoder.decode(entry).replace(/<\/(script)/giu, "<\\/$1");
  return encoder.encode('<!doctype html><meta charset="utf-8">'
    + "<style>html,body{margin:0;background:transparent}</style>"
    + '<div id="root"></div>'
    + `<script type="module">${script}</script>`);
}

/** The public door (`AppsRuntime.build`) plus the hooks only the runtime's
 *  own seams reach: the decision subscriber's, the build lane's, and the wire's. */
export type BuildDoor = AppsRuntime["build"] & Pick<AppsRuntime, "bundleDocument"> & {
  /** THE resume hook: what `onApprovalDecision` fires into, and the only caller
   *  of the builder there is. */
  resume(approvalId: ApprovalId, approved: boolean): Promise<void>;
  /** One build's output frozen onto the app: content-addressed blobs, the row's
   *  compare-and-swap, and a history version. Every seal IS a version. */
  seal(input: SealInput): Promise<AppBundle>;
};

export const createBuildDoor = (
  deps: Pick<AppsRuntimeContext,
    "config" | "engine" | "parkedBuilds" | "updateAppDocument" | "history" | "pruneHistory"
    | "markUnbuilt" | "rungFor" | "requireOwned">,
): BuildDoor => {
  const { config, engine, parkedBuilds, updateAppDocument, history, pruneHistory } = deps;
  const { markUnbuilt, rungFor, requireOwned } = deps;
  const builder = config.build;

  /**
   * The row that says "offered, unanswered".
   *
   * An escalation usually has no row yet — the screen agent decided it could
   * not serve the ask, so it painted nothing — and the proposal has to be
   * readable before any box exists, which is what makes the slot show the ask
   * pending instead of sitting empty. A reseal's app already exists and keeps
   * everything it has.
   */
  const proposeRow = async (
    appId: AppId,
    name: string,
    proposal: AppBuildProposal,
    ctx: RunContext,
  ): Promise<void> => {
    if (await engine.get(APPS_COLLECTION, appId) === null) {
      await engine.put(APPS_COLLECTION, appRecordInput(
        { format: VENDO_APP_FORMAT, id: appId, name, proposal },
        ctx.principal.subject,
        false,
        "screen-agent",
      ));
      return;
    }
    await updateAppDocument(appId, (doc) => ({ ...doc, proposal }));
  };

  const seal: BuildDoor["seal"] = async (input) => {
    if (config.files === undefined) {
      throw new VendoError(
        "validation",
        `sealing ${input.appId}'s bundle needs a files adapter to hold the bytes, and this deployment has none`,
      );
    }
    const bundle = await sealBundleBlobs(input.appId, input.files, input.entry, config.files);
    // One CAS, and no concurrency machinery of its own: content-hash keys never
    // collide, so two concurrent seals both land their bytes and the row's
    // existing compare-and-swap picks the head. The loser survives as the
    // history version appended below.
    const doc = await updateAppDocument(input.appId, (previous) => {
      // `buildFailed` goes with the rest of the build state: the watchdog can
      // tombstone a lane that was merely slow, and a bundle that then lands on
      // that row would read as a failure forever (`entryFor` shows the card).
      const { building: _building, buildStatus: _status, proposal: _proposal,
        buildFailed: _failed, ...rest } = previous;
      return { ...rest, ui: "bundle", bundle };
    });
    await history.append(input.appId, doc, {
      at: bundle.sealedAt,
      intent: doc.name,
      rung: rungFor(doc),
      ...(input.base === undefined ? {} : { base: input.base }),
    });
    await pruneHistory(input.appId);
    return bundle;
  };

  /**
   * The render read. `viewer` is the level, exactly as the served door's was: a
   * person who may SEE a shared app may render it, and one who may not is
   * masked with the not-found every other app door gives them.
   *
   * The hash is checked against its own shape before it becomes a blob key —
   * it arrives from a URL path segment, and a key is not a place to discover
   * what "`..`" means.
   */
  const serveBundle: BuildDoor["bundleDocument"] = async (appId, hex, ctx) => {
    await requireOwned(appId, ctx, "viewer");
    const bytes = config.files === undefined || !/^[0-9a-f]{64}$/.test(hex)
      ? null
      : await readBundleBlob(appId, hex, config.files);
    if (bytes === null) throw new VendoError("not-found", `app ${appId} has no sealed file ${hex}`);
    return bundleDocument(bytes);
  };

  return {
    // A files adapter is half the capability: `seal` has nowhere to put the
    // bytes without one, so a deployment missing it would raise the consent
    // card and spend the yes on a build that throws at its landing.
    available: () => builder?.available() === true && config.files !== undefined,
    bundleDocument: serveBundle,

    async propose(input, ctx) {
      const guardCtx: RunContext = { ...ctx, appId: input.appId };
      const decision = await config.guard.check(
        buildCall(input.appId, input.prompt), buildDescriptor(), guardCtx);
      if (decision.action !== "ask") {
        return { declined: decision.action === "block" ? decision.reason : BUILD_ALREADY_ASKED };
      }
      const approvalId = decision.approval.id;
      try {
        // Parked BEFORE the row: the record is what the decision seam reads, and
        // a yes that lands between these two writes must find the build to run.
        await parkedBuilds.put({
          approvalId,
          appId: input.appId,
          owner: ctx.principal.subject,
          prompt: input.prompt,
          why: input.why,
          ctx: guardCtx,
        });
        await proposeRow(input.appId, input.name, {
          approvalId,
          prompt: input.prompt,
          why: input.why,
          at: new Date().toISOString(),
        }, ctx);
      } catch (error) {
        // The card was parked before either write, so a write that throws leaves
        // an ask standing with no build behind it — a question the person can
        // answer yes to and nothing happens. Taken back through the same verb the
        // chat door uses for an ask nobody needs any more.
        // Best-effort, and swallowed: a cleanup that fails too must not become
        // the answer the caller reacts to instead of the write that failed.
        await config.guard.abandonApprovals?.([approvalId], guardCtx).catch(() => undefined);
        throw error;
      }
      return { approvalId };
    },

    async resume(approvalId, approved) {
      const parked = await parkedBuilds.byApproval(approvalId);
      if (parked === null) return;
      const { appId, prompt, why, ctx } = parked;
      /**
       * The ONE terminal landing every failure shares: the tombstone that turns
       * the claimed slot into the honest failure card. A denial is one of them —
       * it clears the proposal with the rest of the row, and no box was opened.
       *
       * Except on a RESEAL. `markUnbuilt` REPLACES the whole row, which is right
       * for a first build — there is nothing there to lose — and would destroy a
       * working app here. So a reseal that fails keeps everything it had and
       * loses only the build state; the person's app is still their app.
       *
       * The row's own NAME survives either way. `markUnbuilt` replaces the row,
       * so naming it from the prompt renamed the person's app to a 60-character
       * cut of what they typed — and that name then rode into the version
       * history. `fallbackAppName` is left for the row that has no name to keep.
       *
       * READ AT REFUSAL TIME, never before the build. The watchdog below fires
       * minutes after `resume` began, and a snapshot taken back then says the
       * row is unsealed when the build has since sealed it (the tombstone would
       * replace a working app) and says the row exists when the person has since
       * deleted the app (the tombstone would stand it back up). Read raw and
       * untyped, like the placement read: one unparseable row must not decide
       * how every other build fails.
       */
      const refuse = async (reason: string): Promise<void> => {
        const record = await engine.get(APPS_COLLECTION, appId);
        if (record === null) return;
        const existing = (record.data as { doc?: { bundle?: unknown; name?: string } } | null)?.doc;
        if (existing?.bundle === undefined) {
          return await markUnbuilt(appId, existing?.name ?? fallbackAppName(prompt), reason, ctx);
        }
        await updateAppDocument(appId,
          ({ building: _building, buildStatus: _status, proposal: _proposal, ...rest }) => rest);
      };
      if (!approved) return await refuse(BUILD_DECLINED);
      if (builder === undefined || !builder.available()) return await refuse(NO_MACHINE);
      // `ui: "bundle"` is stamped HERE, not at the seal: from this line until the
      // seal lands is minutes, and a row that declared its kind only at the end
      // carried neither bundle signal for all of it — so every
      // `refuseBundleArtifact` call site let a share through, and the grant
      // survived the seal. The row declares what it is becoming from the first
      // moment a box can be spent.
      const doc = await updateAppDocument(appId, (previous) => {
        const { proposal: _proposal, ...rest } = previous;
        return { ...rest, ui: "bundle", building: new Date().toISOString() };
      });
      /**
       * "Progress = chat status lines only" (FINAL SPEC v1), and this is the
       * whole channel: the lane's latest line onto the row the poll already
       * reads. No stream, no subscription, nothing held open.
       *
       * DETACHED AND INDEPENDENT — each label its own write, never chained
       * behind the one before it. Chaining is the obvious way to guarantee the
       * newest line wins, and it deadlocks: it moves the second write into the
       * middle of the box's in-flight turn, where PGlite's single connection
       * queues it forever (the deadlock `ops.ts`'s `txDb` note names). The
       * order two labels seconds apart land in is worth nothing next to that,
       * and the next label overwrites either way.
       *
       * It cannot fight the seal or a tombstone. Those bracket the build in
       * time — `building` is stamped above and cleared by whichever of them
       * lands — so a label that arrives after one of them finds `building`
       * gone and writes nothing; `updateAppRow`'s own compare-and-swap
       * arbitrates anything closer than that.
       *
       * And it cannot fail the build: a status is cosmetic, a build is not, so
       * the write is detached and its failure swallowed. (`onStatus` is called
       * unawaited by the lane but inside its try — a synchronous throw here
       * WOULD be read as a failed build.)
       */
      const noteStatus = (label: string): void => {
        void updateAppDocument(appId, (previous) => previous.building === undefined
          ? previous
          : { ...previous, buildStatus: label }).catch(() => undefined);
      };
      /**
       * FROM HERE THE BUILD IS ON ITS OWN, and it has to be.
       *
       * The guard AWAITS its decision subscribers (`#decideApprovals`), and this
       * is one of them, so awaiting the box held `POST /approvals/decide` open
       * for the whole build — minutes, while the person who just pressed Approve
       * watched a request hang. Detached the way this codebase detaches every
       * other long job (`runInboundDetached`, the umbrella's wire/channels.ts):
       * the row's `building` is all a poll needs, and progress is chat status
       * lines, never a held connection.
       *
       * A detached lane can also die saying nothing, so it is armed with the
       * same dead-man timer `create` uses (`startBuildWatchdog`) and on the same
       * window — cleared only once something terminal has landed, so a lane that
       * threw leaves the switch to land it.
       */
      const watchdog = setTimeout(() => {
        void refuse(BUILD_WATCHDOG_REASON).catch(() => undefined);
      }, buildWatchdogMs());
      (watchdog as { unref?: () => void }).unref?.();
      void (async () => {
        const outcome = await builder.build({
          appId,
          prompt,
          why,
          // Present on a RESEAL: the box starts from what this app already is.
          ...(doc.source === undefined ? {} : { source: doc.source }),
          onStatus: noteStatus,
        }, ctx);
        if (outcome.kind === "failed") await refuse(outcome.why);
        else await seal({ appId, files: outcome.files, entry: outcome.entry });
        clearTimeout(watchdog);
        // Swallowed because the still-armed watchdog is what says so: a lane
        // that threw never reached the clear above.
      })().catch(() => undefined);
    },

    seal,
  };
};
