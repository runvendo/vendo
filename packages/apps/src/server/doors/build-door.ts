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
import { sealBundleBlobs } from "../persistence/app-source.js";
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

/** The public door (`AppsRuntime.build`) plus the two hooks only the runtime's
 *  own seams reach: the decision subscriber's, and the build lane's. */
export type BuildDoor = AppsRuntime["build"] & {
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
    | "markUnbuilt" | "rungFor">,
): BuildDoor => {
  const { config, engine, parkedBuilds, updateAppDocument, history, pruneHistory } = deps;
  const { markUnbuilt, rungFor } = deps;
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

  return {
    available: () => builder?.available() ?? false,

    async propose(input, ctx) {
      const guardCtx: RunContext = { ...ctx, appId: input.appId };
      const decision = await config.guard.check(
        buildCall(input.appId, input.prompt), buildDescriptor(), guardCtx);
      if (decision.action !== "ask") {
        return { declined: decision.action === "block" ? decision.reason : BUILD_ALREADY_ASKED };
      }
      const approvalId = decision.approval.id;
      // Parked BEFORE the row: the record is what the decision seam reads, and a
      // yes that lands between these two writes must find the build to run.
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
      return { approvalId };
    },

    async resume(approvalId, approved) {
      const parked = await parkedBuilds.byApproval(approvalId);
      if (parked === null) return;
      const { appId, prompt, why, ctx } = parked;
      // Read raw and untyped, like the placement read: one unparseable row must
      // not decide how every other build fails.
      const record = await engine.get(APPS_COLLECTION, appId);
      const alreadySealed = (record?.data as { doc?: { bundle?: unknown } } | null)?.doc?.bundle !== undefined;
      /**
       * The ONE terminal landing every failure shares: the tombstone that turns
       * the claimed slot into the honest failure card. A denial is one of them —
       * it clears the proposal with the rest of the row, and no box was opened.
       *
       * Except on a RESEAL. `markUnbuilt` REPLACES the whole row, which is right
       * for a first build — there is nothing there to lose — and would destroy a
       * working app here. So a reseal that fails keeps everything it had and
       * loses only the build state; the person's app is still their app.
       */
      const refuse = async (reason: string): Promise<void> => {
        if (!alreadySealed) return await markUnbuilt(appId, fallbackAppName(prompt), reason, ctx);
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
