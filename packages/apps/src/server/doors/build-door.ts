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
  VENDO_APP_FORMAT,
  VendoError,
  type AppBuildProposal,
  type AppBundle,
  type AppId,
  type ApprovalId,
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
const BUILD_TOOL = "vendo_app_build";
const buildDescriptor = (): ToolDescriptor => ({
  name: BUILD_TOOL,
  description: "Build this app for real: a sandbox installs the packages it needs, writes and tests the code,"
    + " and the result is sealed. It spends a build machine, so it needs the person's yes.",
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
 * It is a HEADER and never a `<meta>` tag, because `frame-ancestors` — the half
 * that says only the host's own page may frame this — is ignored in meta.
 */
export const BUNDLE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';"
  + " img-src data:; frame-ancestors 'self'";

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
  const script = decoder.decode(entry).split("</script").join("<\\/script");
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
      const { building: _building, proposal: _proposal, ...rest } = previous;
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
    available: () => builder?.available() ?? false,
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
        await config.guard.abandonApprovals?.([approvalId], guardCtx);
        throw error;
      }
      return { approvalId };
    },

    async resume(approvalId, approved) {
      const parked = await parkedBuilds.byApproval(approvalId);
      if (parked === null) return;
      const { appId, prompt, why, ctx } = parked;
      // Read raw and untyped, like the placement read: one unparseable row must
      // not decide how every other build fails.
      const record = await engine.get(APPS_COLLECTION, appId);
      const existing = (record?.data as { doc?: { bundle?: unknown; name?: string } } | null)?.doc;
      const alreadySealed = existing?.bundle !== undefined;
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
       */
      const refuse = async (reason: string): Promise<void> => {
        if (!alreadySealed) {
          return await markUnbuilt(appId, existing?.name ?? fallbackAppName(prompt), reason, ctx);
        }
        await updateAppDocument(appId, ({ building: _building, proposal: _proposal, ...rest }) => rest);
      };
      if (!approved) return await refuse(BUILD_DECLINED);
      if (builder === undefined || !builder.available()) return await refuse(NO_MACHINE);
      const doc = await updateAppDocument(appId, (previous) => {
        const { proposal: _proposal, ...rest } = previous;
        return { ...rest, building: new Date().toISOString() };
      });
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
