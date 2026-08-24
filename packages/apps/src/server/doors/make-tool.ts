/**
 * `vendo_make` — the one door a calling agent asks for a screen through, and
 * the three routes behind it: a NEW thing (assembly, escalating to the builder),
 * a change to one app the caller named, and a REMIX of one of the host's own
 * components (the ✦, which opens this conversation and mints nothing itself).
 *
 * It also arms the schedule half of a COMPOUND ask ("build me the board and
 * refresh it every Monday"), through the automation door — which is the same one
 * create operation `vendo_automate`, the manifest fold-in and `agent.on` call.
 * A schedule with nothing to build belongs in `vendo_automate` instead.
 */
import {
  isUnattended,
  log,
  safeErrorMessage,
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
import { automationCard } from "./automate-tool.js";
import { AWAITING_CONSENT, NO_ASSEMBLER, NOTHING_RENDERABLE, NO_MACHINE } from "./build-messages.js";
import { input, optionalString, resolveAppRef } from "./tool-args.js";
import type { AppsRuntime, EditResult } from "../runtime/types.js";

/** An automation authored alongside an app raises its own card (#881).
 *  Published by the side that knows rather than duck-typed out of the tool's
 *  return value at the bridge: the receipt carries words only. The card is about
 *  the RECORD, not the app — an automation has no app reference to render. */
const publishAutomationCard = (
  stream: (update: VendoViewStreamUpdate) => void,
  automation: NonNullable<EditResult["automation"]>,
): void => {
  const part = automationCard(automation.record, automation.enabled, {
    pendingGrants: automation.pendingGrants?.length ?? 0,
  });
  stream({ id: `vendo-automation-${part.automationId}`, part });
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
const nameForUnbuilt = (ask: string): string => {
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
  /** The ask, onto the app's memory. Best-effort, always. `landed` says the
   *  change reached the screen, which is what makes it a remix WISH as well as
   *  an ask — the create arms leave it off because a new app has no wish list. */
  remember(appId: string, landed?: boolean): Promise<void>;
}

const makeNewApp = async (
  { runtime, dependencies, ctx, ask, stream, remember }: MakeCall,
  claimed: string | undefined,
): Promise<ToolOutcome> => {
  // ── THE SEAM (blueprint §1 point 2) ─────────────────────────────────
  // "No agent chooses 'quick screen' vs 'real build'. Every request
  // starts in the cheap screen agent." The id is minted HERE, before the
  // route, because both ends have to use the same one: a build that
  // minted its own would paint onto a second stream and strand the
  // screen agent's own paints beside it.
  //
  // Only `assembled` WITH A ROW ends the call happily. The row is the
  // check that makes that true instead of merely intended: the checks
  // floor upserts it iff the gauntlet actually painted the screen, so a
  // screen agent that saved bytes nobody can render leaves no row.
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
  //  - A sandbox is configured → the person is ASKED. A build spends a
  //    machine, and FINAL SPEC v1's law is that no machine is spent
  //    without their explicit yes, so this raises the standing approval
  //    card and the turn ends here having spent nothing. Their answer,
  //    whenever it lands, is what starts the build (build-door.ts).
  //  - No sandbox → say so, rather than asking for consent to a build
  //    this deployment could not run.
  const escalated = routed?.kind === "escalate";
  if (!escalated) {
    // Assembly produced no screen. Said plainly, at the id whose stream
    // the person is looking at, instead of quietly restarting the ask in
    // a different engine.
    return await failUnbuilt(
      nameForUnbuilt(ask),
      unbuiltSay(
        dependencies.screen === undefined ? NO_ASSEMBLER
          : threw ?? (routed?.kind === "unavailable" ? routed.why : NOTHING_RENDERABLE),
      ),
    );
  }
  const title = nameForUnbuilt(ask);
  if (!runtime.build.available()) {
    return await failUnbuilt(title, NO_MACHINE);
  }
  // The ask travels verbatim; the escalation's one line rides beside it, so
  // the build never re-routes through a second agent. Nothing waits on the
  // card — it stands until the person answers it.
  const proposed = await runtime.build.propose(
    { appId, name: title, prompt: ask, why: routed.why }, ctx);
  if ("declined" in proposed) {
    return await failUnbuilt(title, unbuiltSay(proposed.declined));
  }
  await remember(appId);
  return receipt({ id: appId, title, status: "awaiting-consent", say: AWAITING_CONSENT });
};

const changeExistingApp = async (
  { runtime, ctx, ask, stream, remember }: MakeCall,
  app: string,
): Promise<ToolOutcome> => {
  const appId = await resolveAppRef(runtime, app, ctx);
  const result = await runtime.edit(appId, ask, ctx);
  // The ASK is recorded whether or not the change landed: the person DID ask
  // this of this app, and the next editor reading "asked for X, then asked for
  // X again, narrower" is reading the truth. Whether it landed travels with it,
  // because a remix's wish list is the other thing this writes and that one
  // replays on every Update — an attempt the person never got back is not a
  // change to replay.
  await remember(appId, result.failure === undefined);
  // An automation this edit authored raises its own card. Published HERE, by the
  // side that knows, rather than duck-typed out of this tool's return value at
  // the bridge: the receipt carries words only.
  if (result.automation !== undefined && stream !== undefined) {
    publishAutomationCard(stream, result.automation);
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

/**
 * The ✦ ONE DOOR: the person asked for a change to one of the HOST's own
 * components, so what they want is a REMIX — an ordinary app carrying a seed,
 * which is what the wrapper discovers by component name and mounts in the
 * original's place. Minting a plain app here instead leaves the ✦ doing nothing
 * the person can see.
 *
 * Through the EXISTING seed door, never a second mint path: it validates the
 * component against the captured baselines, dedupes per person, records the
 * wish, and runs it through the ordinary edit door as one operation.
 */
const remixComponent = async (
  make: MakeCall,
  component: string,
  request: string,
  slot: string | undefined,
): Promise<ToolOutcome> => {
  // Asked BEFORE the mint, because afterwards the two cases are
  // indistinguishable: a wish repeated VERBATIM leaves a deduped remix in
  // exactly the state a fresh mint would be in, and reading the wish list back
  // called it new — so the repeat landed nowhere and the receipt said "ready".
  const before = await make.runtime.list(make.ctx);
  // The person's OWN words, not `ask`: the `<context>` fence that named the
  // component is this call's background, and a seed's wishes are replayed
  // verbatim onto every future version the host ships.
  const seeded = await make.runtime.seed.from({
    component,
    instruction: request,
    ...(slot === undefined ? {} : { slot }),
  }, make.ctx);
  // No `remember` on this arm: the seed door already recorded the wish, and
  // remembering it again would put it on the list twice.
  //
  // A component that already has a remix DEDUPES, and the seed door drops the
  // riding wish when it does. The fence stays in the thread, so a follow-up wish
  // arrives named this way too — that is an edit of the remix, and this being
  // the one door, it has to land as one rather than vanish.
  //
  // The question is "did the seed door apply MY wish?", and it takes both halves
  // to answer. The app existing beforehand catches the ordinary dedupe, INCLUDING
  // a wish repeated verbatim, which leaves a remix in exactly the state a fresh
  // mint would be in. The wish list catches the racing pair the seed door
  // resolves after the fact: two gestures both find nothing, both mint, and the
  // loser is handed the WINNER's app with the loser's own wish deleted alongside
  // its app — an app that never existed for either caller to have seen.
  // MEMBERSHIP, not recency: the seed door paints the port before the first
  // edit now, and in a race the loser's wish can land on the winner DURING
  // that window — `at(-1)` then reads the racer's wish and re-applies this
  // one. The verbatim-repeat case never reaches this half: a repeat's app is
  // in `before`, and the first half already routed it to the edit door.
  const applied = !before.some(({ id }) => id === seeded.id)
    && (seeded.seed?.wishes.includes(request) ?? false);
  if (!applied) return await changeExistingApp(make, seeded.id);
  return receipt({
    id: seeded.id,
    title: seeded.name,
    status: seeded.buildFailed === undefined ? "ready" : "failed",
    say: seeded.buildFailed === undefined
      ? `${seeded.name} is on the page, in place of the original.`
      : `I couldn't remix ${component}.`,
  });
};

/**
 * A COMPOUND ask: "build me the board AND refresh it every Monday".
 *
 * The app is built either way — this only decides whether the automation door is
 * asked for the second half, because asking it spends a model call and most
 * makes are a screen and nothing else. Deliberately narrow: it wants a recurrence
 * WORD, not the bare "every" in "show every transaction", because a false
 * positive here is an automation nobody asked for.
 */
const ASKS_TO_RECUR = /\b(?:every|each)\s+(?:\d+\s+)?(?:minute|hour|day|night|morning|afternoon|evening|week|weekday|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b|\b(?:daily|hourly|nightly|weekly|monthly|on a schedule|on a timer)\b/i;

/**
 * What the person is told when the door stayed shut: the redirect, never
 * silence. Conditional, because the sniff below is a WORD in the person's own
 * sentence and "Tracked monthly" is a caption, not a schedule — a sentence that
 * assumes it was a schedule would be wrong most of the time it appeared. It says
 * nothing about WHY, so it is equally true of a remix and of a row this door
 * could not read back.
 */
const SCHEDULE_ELSEWHERE = "If you also meant to have something run on a schedule, "
  + "that didn't get set up here — ask for it in the main chat.";

/**
 * Arm the schedule the same ask asked for, on the app it just produced.
 *
 * Through `runtime.automation.author` — so a schedule that arrives with an app
 * and one asked for on its own are planned, created, armed and audited by
 * exactly the same code, down to the one create operation underneath.
 *
 * Never fatal. The app is on the person's page; an automation that could not be
 * planned is a sentence on the receipt, not a failed make.
 *
 * NOT ON A REMIX (#1568). A remix is the ✦ on one of the host's own components,
 * and what it may do is edit that component, read its data and call its declared
 * actions — authoring an automation is not on that list, and this arm is the one
 * way it got there. It got there on a purely COSMETIC wish, too: the sniff reads
 * the person's own words, so `a caption that reads "Tracked monthly"` armed a
 * schedule, asked its author to grant 34 scopes for a text label, and left the
 * remix repainted as an automation board with nothing in it. `seed` is what says
 * a row is a remix (`compose-apps.ts`'s `storedScreen` reads it the same way), so
 * the ✦ mint and every later wish are covered alike — a follow-up arrives naming
 * the APP, not the component.
 */
const withCompoundSchedule = async (
  { runtime, ctx, ask, stream }: MakeCall,
  outcome: ToolOutcome,
): Promise<ToolOutcome> => {
  if (outcome.status !== "ok") return outcome;
  const built = makeReceiptSchema.safeParse(outcome.output);
  if (!built.success) return outcome;
  const made = built.data;
  // `null` is an ANSWER (no such row, so not a remix); `undefined` is the read
  // itself not resolving, and that FAILS CLOSED — `seed` is the only thing
  // standing between a remix and the automation door, so a read that answered
  // nothing is not a licence to arm one.
  //
  // Both ahead of the failed-build gate below, because a failure is the LOUDEST
  // way to drop the ask: asked to "refresh this view every Monday morning", the
  // screen agent tries to build the schedule into the view, cannot, and the
  // person is told only that it did not go through (browser walk, 2026-08-20).
  const document = await runtime.get(made.id as AppId, ctx).catch(() => undefined);
  if (document === undefined || document?.seed !== undefined) {
    return receipt({ ...made, say: `${made.say} ${SCHEDULE_ELSEWHERE}` });
  }
  if (made.status === "failed") return outcome;
  const authored = await runtime.automation
    .author({ appId: made.id as AppId, instruction: ask, mode: "goal" }, ctx)
    .catch((error: unknown) => {
      log({
        code: "apps.compound-schedule-not-armed",
        level: "warn",
        message: `[vendo] the schedule asked for alongside ${made.id} was not armed: ${safeErrorMessage(error)}`,
      });
      return { ok: false, issues: [safeErrorMessage(error)] } as const;
    });
  if (!authored.ok) {
    return receipt({ ...made, say: `${made.say} I couldn't set up the schedule: ${authored.issues.join("; ")}` });
  }
  if (stream !== undefined) {
    publishAutomationCard(stream, { record: authored.record, enabled: authored.armed });
  }
  return receipt({
    ...made,
    say: authored.armed
      ? `${made.say} It runs on the schedule you asked for.`
      : `${made.say} The schedule is set up but not armed — it needs the user's permission first.`,
  });
};

export const runMakeTool = async (
  runtime: AppsRuntime,
  dependencies: AgentToolsDataDependencies,
  call: ToolCall,
  ctx: RunContext,
): Promise<ToolOutcome> => {
  const args = input(call.args, ["request"], ["app", "context", "slot", "component"]);
  const app = optionalString(args.app, "app");
  const slot = optionalString(args.slot, "slot");
  const component = optionalString(args.component, "component");
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
  const remember = async (appId: string, landed?: boolean): Promise<void> => {
    const recorded = { appId, ask: request, ...(landed === undefined ? {} : { landed }) };
    await runtime.remember(recorded, ctx).catch((error: unknown) => {
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
  // `slot` says where a NEW app lands. On a change it would have to mean
  // "and also move it", which evicts whatever holds that slot off the back
  // of an edit nobody aimed there — so it is refused, by name, at the one
  // tool that does the moving. Refused before the ref is resolved: the
  // answer does not depend on which app was meant.
  if (app !== undefined && slot !== undefined) {
    throw new VendoError(
      "validation",
      "`slot` says where a new app lands. To move an app that already exists, call vendo_apps_pin with that app and slot.",
    );
  }
  // `app` names one that already exists, `component` one of the HOST's own to
  // remix; neither means something new. `app` first, because a caller who named
  // a specific app has already answered the question `component` asks.
  const outcome = app !== undefined ? await changeExistingApp(make, app)
    : component !== undefined ? await remixComponent(make, component, request, claimed)
      : await makeNewApp(make, claimed);
  // The schedule half of a compound ask, read from the person's OWN words — the
  // `<context>` fence is one calling agent's background, and a stale aside must
  // not arm anything.
  return ASKS_TO_RECUR.test(request) ? await withCompoundSchedule(make, outcome) : outcome;
};
