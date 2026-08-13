/**
 * `vendo_make` — the one door a calling agent asks for a screen through, and
 * the two routes behind it: a NEW thing (assembly, escalating to the builder)
 * and a change to one app the caller named.
 *
 * Lifted out of `createAgentTools` unchanged.
 */
import {
  isUnattended,
  log,
  VENDO_VIEW_STREAM,
  VendoError,
  vendoViewStreamId,
  type AppId,
  type Json,
  type RunContext,
  type ToolCall,
  type ToolOutcome,
  type VendoViewStreamUpdate,
  type VendoViewStreamingToolCall,
} from "@vendoai/core";
import {
  makeReceiptSchema,
  type MakeReceipt,
} from "../../contract/index.js";
import type { AgentToolsDataDependencies } from "./agent-tools.js";
import { NO_ASSEMBLER, NOTHING_RENDERABLE, NO_MACHINE } from "./build-messages.js";
import { input, optionalString, resolveAppRef } from "./tool-args.js";
import type { AppsRuntime, CreateServerWork, EditResult } from "../runtime/types.js";

/** Wave 9 — a ladder-authored automation raises its own card, on create and
 *  edit alike (#881). Published by the side that knows rather than duck-typed
 *  out of the tool's return value at the bridge: the receipt carries words
 *  only. */
const publishAutomationCard = (
  stream: (update: VendoViewStreamUpdate) => void,
  app: { id: AppId; name: string; description?: string },
  automation: NonNullable<EditResult["automation"]>,
): void => {
  stream({
    id: `vendo-automation-${app.id}`,
    part: {
      type: "data-vendo-automation",
      appId: app.id,
      name: app.name,
      enabled: automation.enabled,
      ...(automation.trigger === undefined ? {} : { trigger: automation.trigger }),
      ...(app.description === undefined || app.description.length === 0
        ? {}
        : { description: app.description }),
      ...((automation.pendingGrants ?? []).length === 0
        ? {}
        : { pendingGrants: automation.pendingGrants!.length }),
    },
  });
};

/**
 * Contract §3.1 — the caller's `context` appended to the request, clearly
 * delimited.
 *
 * It exists for outside agents whose conversation we cannot see: over MCP there is
 * no transcript for us to attach, so they pass whatever background helps. On OUR
 * doors the runtime's own transcript stays authoritative and this is supplemental
 * — which is why it is appended rather than merged, and fenced rather than run
 * together with the ask. Free text, never a messages array: every framework's
 * message format differs and a string is universal.
 */
const withContext = (request: string, context: string | undefined): string =>
  context === undefined ? request : `${request}\n\n<context>\n${context}\n</context>`;

/** The tool's whole model-facing answer. Parsed, so the four-field law is enforced
 *  here rather than trusted — a document that leaked into `output` would fail. */
const receipt = (value: MakeReceipt): ToolOutcome => ({
  status: "ok",
  output: makeReceiptSchema.parse(value) as unknown as Json,
});

/**
 * What to call an app that was never built — the one receipt with no document to
 * read a name off (`MakeReceipt.title` is required).
 *
 * The `<Plan>`'s own name first, because the person is already looking at that
 * plan's skeleton titled with this exact string, so the sentence and the card are
 * about the same thing. Otherwise the ask, collapsed and capped — the same answer
 * a failed build record's name field gets.
 */
const nameForUnbuilt = (plan: string | undefined, ask: string): string => {
  const named = plan === undefined ? null : /<Plan\b[^>]*\bname="([^"]+)"/.exec(plan);
  const title = named?.[1]?.trim();
  if (title !== undefined && title !== "") return title;
  const collapsed = ask.replace(/\s+/g, " ").trim();
  return collapsed === "" ? "Vendo app" : collapsed.slice(0, 60);
};

/**
 * What an ask that produced no screen says to the person.
 *
 * The seam used to answer this with a second engine, so the four ways assembly
 * can come back empty — unwired, threw, `unavailable`, or `assembled` with no
 * row — were all silently absorbed. They are now the answer: an unwired
 * assembler is a composition bug and a composition bug that quietly swaps
 * engines is a bug nobody fixes. The reason travels verbatim because every one
 * of these is authored (a `why`, a thrown message, or the two constants below)
 * and a person reading "I couldn't put that screen together" alone has nothing
 * to act on.
 */
const unbuiltSay = (why: string): string =>
  why.trim() === ""
    ? "I couldn't put that screen together."
    : `I couldn't put that screen together — ${why.trim()}`;

/** What both routes read: the doors, the ask as the engines see it, the view
 *  stream this call arrived on, and the memory write. */
interface MakeCall {
  runtime: AppsRuntime;
  dependencies: AgentToolsDataDependencies;
  ctx: RunContext;
  /** The person's words, plus the caller's `<context>` fence when it sent one. */
  ask: string;
  /** The client parts this execution may publish, when the caller opened a stream. */
  stream: ((update: VendoViewStreamUpdate) => void) | undefined;
  /** The ask, onto the app's memory. Best-effort, always. */
  remember(appId: string): Promise<void>;
}

const makeNewApp = async (
  { runtime, dependencies, ctx, ask, stream, remember }: MakeCall,
  claimed: string | undefined,
): Promise<ToolOutcome> => {
  // ── THE SEAM (blueprint §1 point 2) ─────────────────────────────────
  // "No agent chooses 'quick screen' vs 'real build'. Every request
  // starts in the cheap screen agent." The id is minted HERE, before the
  // route, because both ends have to use the same one: an escalation
  // leaves `plan.vendo` and its painted skeleton at this id, and a build
  // that minted its own would strand that skeleton on a second stream as
  // a card that builds forever.
  //
  // Only `assembled` WITH A ROW ends the call happily. The row is the
  // check that makes that true instead of merely intended: `authored`
  // upserts it iff the seam actually compiled and painted the document,
  // so a screen agent that saved bytes nobody can render leaves no row.
  //
  // TWO answers now, and no third. `escalate` is a request for the
  // builder (§4.5's receiving end, below); everything else is assembly
  // coming back empty, and assembly coming back empty is the ANSWER —
  // there is no second engine behind this seam to rescue it with.
  const appId = `app_${globalThis.crypto.randomUUID()}` as AppId;
  // B1 — the claim rides the MINT, not the landing, for BOTH engines.
  // Claiming after assembly returned left the slot empty for the whole
  // of a fast make, and left nothing at all behind a failed one, so the
  // slot stayed empty and the person heard about the failure only in the
  // conversation. The builder route has always claimed here (`create`'s
  // own `slot`, which this door no longer needs to pass).
  if (claimed !== undefined) await dependencies.claimSlot(appId, claimed, ctx);
  /** The one exit for an ask no engine landed: the tombstone that turns
   *  the claimed slot into the honest failure card, then the receipt
   *  that says so — the record's reason is the sentence the person is
   *  told, verbatim, because there is nothing else true to record. */
  const failUnbuilt = async (title: string, say: string): Promise<ToolOutcome> => {
    if (claimed !== undefined) await dependencies.markUnbuilt(appId, title, say, ctx);
    return receipt({ id: appId, title, status: "failed", say });
  };
  let threw: string | undefined;
  const routed = dependencies.screen === undefined
    ? undefined
    : await dependencies.screen.assemble({
      appId,
      request: ask,
      ...(stream === undefined ? {} : {
        onView: (part) => stream({ id: vendoViewStreamId(part.appId), part }),
      }),
    }, ctx).catch((error: unknown) => {
      threw = error instanceof Error ? error.message : String(error);
      log({
        code: "apps.screen-agent-serve-failed",
        level: "warn",
        message: `[vendo] the screen agent could not serve ${appId} — ${threw}`,
      });
      return undefined;
    });
  if (routed?.kind === "assembled") {
    const stored = await runtime.get(appId, ctx).catch(() => null);
    if (stored !== null) {
      await remember(appId);
      // No claim here: the slot has held this id since the mint above,
      // and the row already names it.
      return receipt({
        id: stored.id,
        title: stored.name,
        status: "ready",
        // THE BUILDER'S OWN WORDS, verbatim (`ScreenOutcome.say`). It is the
        // only thing that knows what it built — which saves painted, and
        // what each query delivered — and the sentence below knows only a
        // name, which is why the calling agent used to describe parts of a
        // screen nothing had claimed. The fallback stands for a run that
        // said nothing at all: `say` is required, and a name on a screen is
        // the one thing still true.
        say: routed.say ?? `${stored.name} is on your screen.`,
      });
    }
  }
  // ── §4.5's RECEIVING END ────────────────────────────────────────────
  // An escalation is the screen agent asking for the builder by name; it
  // is not the seam failing. Two answers, and the deployment's own shape
  // picks which:
  //
  //  - A sandbox is configured → the build runs. Same `create` a
  //    server-needing ask has always taken, at the SAME app id, so the
  //    plan's skeleton and the finished app share one stream and the
  //    outline becomes the app. The escalated plan rides in as the
  //    brief; the ask still travels verbatim.
  //  - No sandbox → say so, rather than spending a full build's latency
  //    to arrive at a worse version of the screen the person was already
  //    shown. The skeleton is left as it is — the UI unmounts a
  //    still-forming card once the turn is over
  //    (`chrome/thread/parts.tsx`), so the last word is this receipt.
  const escalated = routed?.kind === "escalate";
  const plan = !escalated
    ? undefined
    : await dependencies.escalatedPlan?.(appId, ctx).catch(() => undefined);
  if (!escalated) {
    // Assembly produced no screen. Said plainly, at the id whose stream
    // the person is looking at, instead of quietly restarting the ask in
    // a different engine.
    return await failUnbuilt(
      nameForUnbuilt(undefined, ask),
      unbuiltSay(
        dependencies.screen === undefined ? NO_ASSEMBLER
          : threw ?? (routed?.kind === "unavailable" ? routed.why : NOTHING_RENDERABLE),
      ),
    );
  }
  if (!runtime.machine.available()) {
    return await failUnbuilt(
      // The name on the skeleton they are looking at, so the sentence and
      // the card are about the same thing.
      nameForUnbuilt(plan, ask),
      NO_MACHINE,
    );
  }
  let unsaved: string | undefined;
  let serverWork: CreateServerWork | undefined;
  const created = await runtime.create({
    appId,
    prompt: ask,
    ...(plan === undefined ? {} : { plan }),
    // No `slot`: the claim went down at the mint above, which is the
    // same instant `create` would have made it for an id of its own.
    onUnsaved: (reason) => { unsaved = reason; },
    // The lane's outcome arrives in up to two calls on one envelope shape
    // (#881): the success half (the automation that raises the card below,
    // caveat issues) and the failure report (`failed` — server work the plan
    // required that did not get built), which reaches the receipt's STATUS
    // too, not just its words (see the return below): `create` resolves with
    // the document either way, and an unqualified "it's on your screen" is
    // how an empty app gets declared successful. Merged, never overwritten —
    // a failure must not erase the automation that DID land, or vice versa.
    onServerWork: (work) => { serverWork = { ...serverWork, ...work }; },
    ...(stream === undefined ? {} : {
      onView: (part) => stream({ id: vendoViewStreamId(part.appId), part }),
    }),
  }, ctx);
  // An unsaved create has no row to remember onto; `remember` says so
  // and moves on, which is the same non-event every other failure is.
  await remember(created.id);
  // #881 — a create that rode its plan to an automation raises the same card
  // an edit does. Before this, the envelope died inside `create` and the
  // person's first-ask automation surfaced nothing: no card, no grants.
  if (serverWork?.automation !== undefined && stream !== undefined) {
    publishAutomationCard(stream, created, serverWork.automation);
  }
  // View-only (the store refused the write): the screen IS on the user's
  // page, so this is a success with a caveat, not a failure. Reporting it
  // as an error made the agent apologize for a rendered view and rebuild
  // it twice more — three cards, one prompt (live 2026-07-27). The
  // caveat rides `say`, which is the whole point of `say`: one true
  // sentence, and nothing to react to.
  //
  // FAILED SERVER WORK is not that: the app on screen is missing the half its
  // plan asked for, so it is `"partial"` (§3.1 law 4). `say` alone was the same
  // silent success one field over — the sentence said the server side did not
  // get built while every reader that BRANCHES on `status` saw plain "ready".
  const failedWork = serverWork?.failed ?? [];
  return receipt({
    id: created.id,
    title: created.name,
    status: failedWork.length === 0 ? "ready" : "partial",
    say: failedWork.length !== 0
      ? `I built the screen, but the server-side part didn't get built: ${failedWork.join("; ")}. The app works for viewing — ask me to try the build again.`
      : unsaved === undefined
        ? `${created.name} is on your screen.`
        : `${created.name} is on your screen, though I couldn't save it to your apps.`,
  });
};

const changeExistingApp = async (
  { runtime, ctx, ask, stream, remember }: MakeCall,
  app: string,
): Promise<ToolOutcome> => {
  const appId = await resolveAppRef(runtime, app, ctx);
  const result = await runtime.edit(appId, ask, ctx);
  // Recorded whether or not the change landed: the person DID ask this of
  // this app, and the next editor reading "asked for X, then asked for X
  // again, narrower" is reading the truth.
  await remember(appId);
  // Wave 9 — a ladder-authored automation raises its own card. Published
  // HERE, by the side that knows, rather than duck-typed out of this tool's
  // return value at the bridge: the receipt carries words only.
  //
  // The trigger goes over WHOLE, which is what carries the automation's terms
  // (`Trigger.rules` — the sentences its author wrote) to the card with no
  // second field to disagree with the document. The document's trigger is the
  // one this edit authored and landed, so what the card lists is what runs.
  if (result.automation !== undefined && stream !== undefined) {
    publishAutomationCard(stream, result.app, result.automation);
  }
  return receipt({
    id: result.app.id,
    title: result.app.name,
    status: result.failure === undefined ? "ready" : "failed",
    say: result.failure === undefined
      ? `${result.app.name} is updated.`
      : `I couldn't make that change to ${result.app.name}.`,
  });
};

export const runMakeTool = async (
  runtime: AppsRuntime,
  dependencies: AgentToolsDataDependencies,
  call: ToolCall,
  ctx: RunContext,
): Promise<ToolOutcome> => {
  const args = input(call.args, ["request"], ["app", "context", "slot"]);
  const app = optionalString(args.app, "app");
  const slot = optionalString(args.slot, "slot");
  // The slot, and ONLY the slot, needs a person there: it claims a place
  // on somebody's page and evicts whatever held it. Creation does not, so
  // an unattended run still builds what it was asked for and simply takes
  // no slot — this is the whole of that rule (ruled 2026-08-06; the
  // guard's presence-only refusal covers the pin tools, never make).
  // The refusal below still reads `slot`, because "you aimed a new app at
  // a slot on an EDIT" is wrong however present the person is.
  const claimed = isUnattended(ctx) ? undefined : slot;
  const stream = (call as VendoViewStreamingToolCall)[VENDO_VIEW_STREAM];
  const request = args.request as string;
  const ask = withContext(request, optionalString(args.context, "context"));
  /**
   * The ask, onto the app's memory — the FRONT DOOR's job, because this is
   * the one place that sees every request that touched an app whichever
   * engine served it (assembly, the builder, the conductor fall-through,
   * an edit).
   *
   * `request` and not `ask`: the memory holds what the PERSON said. The
   * `<context>` fence is one calling agent's background for one call, and
   * replaying it to every future editor as though the person had typed it
   * is how a stale aside becomes a standing requirement.
   *
   * Best-effort, always. There is no arrangement of a lost memory write
   * that is worse than failing a make the person can already see.
   */
  const remember = async (appId: string): Promise<void> => {
    await runtime.remember({ appId, ask: request }, ctx).catch((error: unknown) => {
      log({
        code: "apps.ask-not-recorded",
        level: "warn",
        message: `[vendo] the ask was not recorded on ${appId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    });
  };
  const make: MakeCall = { runtime, dependencies, ctx, ask, stream, remember };
  if (app === undefined) return await makeNewApp(make, claimed);
  // `slot` says where a NEW app lands. On a change it would have to mean
  // "and also move it", which evicts whatever holds that slot off the back
  // of an edit nobody aimed there — so it is refused, by name, at the one
  // tool that does the moving. Refused before the ref is resolved: the
  // answer does not depend on which app was meant.
  if (slot !== undefined) {
    throw new VendoError(
      "validation",
      "`slot` says where a new app lands. To move an app that already exists, call vendo_apps_pin with that app and slot.",
    );
  }
  return await changeExistingApp(make, app);
};
