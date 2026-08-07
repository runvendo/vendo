import {
  VENDO_APPS_PIN_TOOL,
  VENDO_APPS_UNPIN_TOOL,
  VENDO_MAKE_TOOL,
  VENDO_TOOL_TITLES,
  appIdSchema,
  isUnattended,
  VENDO_VIEW_STREAM,
  VendoError,
  makeReceiptSchema,
  vendoViewStreamId,
  type AppDocument,
  type AppId,
  type Json,
  type MakeReceipt,
  type RecordQuery,
  type RunContext,
  type ScreenAssembler,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
  type VendoViewStreamingToolCall,
} from "@vendoai/core";
import type { AppDataAccess } from "./app-data.js";
import { NO_ASSEMBLER, NOTHING_RENDERABLE, NO_MACHINE, type AppsRuntime } from "./runtime.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/** Exported so the apps PACK can declare exactly these tools through the public
 *  `Pack.tools` slot rather than a privileged path into the registry.
 *
 *  Titles are applied in ONE place below, from core's shared table, rather than
 *  authored per entry: `ToolListing.title` falls back to the identifier, so a
 *  tool that forgets its title hands the model `vendo_apps_open` as its human
 *  label — which is how it reached a live refusal message (wave-1 proof E1-5). */
const descriptors = [
  {
    // The agent's streaming-view bridge keys on this exact core-defined name.
    name: VENDO_MAKE_TOOL,
    // Three sentences of law, each paid for by a live failure. The data-honesty
    // one: calling agents were pre-computing figures into the request ("Total
    // Spent: $0.00"), which the engine rejects as hand-typed — the screen binds
    // live host data itself. The retry one: a rejected change is worth one
    // narrower attempt on the same app, and was worth saying because the
    // alternative the model reached for was rebuilding it from scratch.
    description: "Make the user something to look at — a screen, or a full app — from a plain-language request. Say what they want in your own words; Vendo decides whether to assemble a screen or build an app, and it arrives on the user's own page. Pass `app` only to change one specific existing app — its id, or its name exactly as the user said it, which is resolved against their own apps (if two share that name you are told both, so ask which one); leave it out and Vendo decides whether to continue the last one or start something new. A recurring or scheduled task belongs here too: describe the schedule and the action in the request and it is armed as part of the same call; there is no separate automations tool. One app can hold SEVERAL automations, so to add another one to an app it already has, name that app in `app` and describe the new schedule — never refuse a second schedule. Never bake data values you computed or fetched (counts, totals, amounts) into the request — it binds live host data itself and hardcoded figures fail its checks. Never specify fonts, colors, or branding — it inherits the host theme. You get back a one-line receipt to say out loud, never the screen itself; if the receipt says \"failed\", try once more on the same `app` with a narrower request rather than rebuilding it. Pass `slot` only when the request names a particular place on the user's page for it to land — the host publishes those slot ids, so pass one you were told rather than one you invented, and whatever held that place is replaced. `slot` is for something NEW: to move an app that already exists, use the pin tool instead.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        request: { type: "string", minLength: 1 },
        app: { type: "string", minLength: 1 },
        context: { type: "string", minLength: 1 },
        slot: { type: "string", minLength: 1 },
      },
      required: ["request"],
      additionalProperties: false,
    },
    // Structurally rung 1 whichever way it routes: a jailed document render with
    // no server, host-tool execution, or egress. The lifecycle write is only to
    // Vendo's own app store, so consent policy treats it like opening a local
    // view — and Yousef's ruling (2026-07-28) says the same about a change: the
    // ceremony belongs on what a screen DOES (money, messages, deletion), never
    // on the person rearranging their own view. Actions INSIDE the screen are
    // guarded individually at call time. History and undo are the safety net.
    risk: "read",
  },
  {
    name: "vendo_apps_rebase_pin",
    description: "Rebase one drifted remixed pin of a Vendo app onto the host's updated component: re-fork the new captured baseline and replay the recorded edit intents in order. Use when an edit result or open() payload reports drifted pins and the user asks to update the remix. If the result has status \"failed\", nothing was changed; it lists which intents replayed and which failed.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        appId: { type: "string", minLength: 1 },
        slot: { type: "string", minLength: 1 },
      },
      required: ["appId", "slot"],
      additionalProperties: false,
    },
    risk: "write",
  },
  {
    name: "vendo_apps_open",
    description: "Open the latest serving surface for a Vendo app. `appId` is the app's id, or its name exactly as the user said it, resolved against their own apps (if two share that name you are told both, so ask which one they mean).",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        appId: {
          type: "string",
          minLength: 1,
          description: "The app's id, or its name as the user says it.",
        },
      },
      required: ["appId"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: VENDO_APPS_PIN_TOOL,
    description: "Put one of the user's own apps into a named slot on the page they are looking at, where it stays until they move it. `app` is the app's id, or its name exactly as the user said it, resolved against their own apps (if two share that name you are told both, so ask which one they mean). `slot` is a slot id the host published for that place on the page — pass one you were told rather than one you invented. Whatever held that slot is replaced, and the reply names it as `evicted` so you can say what moved.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        app: {
          type: "string",
          minLength: 1,
          description: "The app's id, or its name as the user says it.",
        },
        slot: {
          type: "string",
          minLength: 1,
          description: "The slot id the host published for that place on the page.",
        },
      },
      required: ["app", "slot"],
      additionalProperties: false,
    },
    // A `write`, and only a write: one small row saying where an app the user
    // already owns sits on their own page. It is reversible by the tool below,
    // and history is the safety net. What keeps it away from an unattended run
    // is `PRESENCE_ONLY_TOOLS`, not an inflated grade.
    risk: "write",
  },
  {
    name: VENDO_APPS_UNPIN_TOOL,
    description: "Take an app back out of a slot on the user's page. The app itself is untouched — it stays in their apps and can be put back any time. `app` is the app's id or its name as the user said it; `slot` is the slot it is in.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        app: {
          type: "string",
          minLength: 1,
          description: "The app's id, or its name as the user says it.",
        },
        slot: {
          type: "string",
          minLength: 1,
          description: "The slot the app is in.",
        },
      },
      required: ["app", "slot"],
      additionalProperties: false,
    },
    risk: "write",
  },
  {
    name: "vendo_apps_data_list",
    description: "List records from a declared Vendo app data collection.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        appId: { type: "string", minLength: 1 },
        collection: { type: "string", minLength: 1 },
        refs: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
        limit: { type: "integer", minimum: 1 },
        cursor: { type: "string", minLength: 1 },
      },
      required: ["appId", "collection"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "vendo_apps_data_put",
    description: "Create or replace a record in a declared Vendo app data collection.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        appId: { type: "string", minLength: 1 },
        collection: { type: "string", minLength: 1 },
        id: { type: "string", minLength: 1 },
        data: {},
        refs: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
      },
      required: ["appId", "collection", "id", "data"],
      additionalProperties: false,
    },
    risk: "write",
  },
  {
    name: "vendo_apps_data_delete",
    description: "Delete a record from a declared Vendo app data collection.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        appId: { type: "string", minLength: 1 },
        collection: { type: "string", minLength: 1 },
        id: { type: "string", minLength: 1 },
      },
      required: ["appId", "collection", "id"],
      additionalProperties: false,
    },
    risk: "write",
  },
] satisfies ToolDescriptor[];

export const agentToolDescriptors: ToolDescriptor[] = descriptors.map((descriptor) => {
  // Deliberately NOT `?? descriptor.name`: a silent fallback to the identifier is
  // the defect itself. A tool missing from the table stays titleless and
  // `agent-tools.test.ts` fails, which is the loud outcome.
  const title = VENDO_TOOL_TITLES[descriptor.name];
  return title === undefined ? descriptor : { ...descriptor, title };
});

const input = (
  value: Json,
  required: string[],
  optional: string[] = [],
): Record<string, Json> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VendoError("validation", "tool input must be an object");
  }
  const record = value as Record<string, Json>;
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected !== undefined) throw new VendoError("validation", `unexpected input property: ${unexpected}`);
  for (const key of required) {
    if (typeof record[key] !== "string" || (record[key] as string).trim() === "") {
      throw new VendoError("validation", `${key} must be a non-empty string`);
    }
  }
  return record;
};

const optionalString = (value: Json | undefined, name: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new VendoError("validation", `${name} must be a non-empty string`);
  }
  return value;
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

const optionalRefs = (value: Json | undefined): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VendoError("validation", "refs must be an object");
  }
  const refs: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "" || typeof item !== "string" || item.trim() === "") {
      throw new VendoError("validation", "refs must have non-empty string keys and values");
    }
    refs[key] = item;
  }
  return refs;
};

const optionalLimit = (value: Json | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new VendoError("validation", "limit must be a positive integer");
  }
  return value;
};

export interface AgentToolsDataDependencies {
  data: AppDataAccess;
  requireOwned(appId: AppId, ctx: RunContext): Promise<AppDocument>;
  /** B1 — claim the slot for an id this door just minted, before either engine
   *  runs. `AppsRuntime.place` cannot: it gates on an app record, and there is
   *  none yet. Filled by the runtime that constructs this registry. */
  claimSlot(appId: AppId, slot: string, ctx: RunContext): Promise<void>;
  /** B1's other end — the terminal record for an id assembly never landed, so a
   *  claimed slot reads as the honest failure card instead of a skeleton that
   *  ages out. The same tombstone a failed build leaves. */
  markUnbuilt(appId: AppId, name: string, reason: string, ctx: RunContext): Promise<void>;
  /** UI-generation blueprint §1 point 2 — the screen agent. Threaded from
   *  `AppsConfig.screen`, which composition fills; see the routing block in the
   *  `vendo_make` handler below. Unfilled, `vendo_make` has nothing to assemble
   *  with and says so. */
  screen?: ScreenAssembler;
  /** §4.5's other half — the escalated `plan.vendo`, read back out of the app's
   *  workspace so the build anchors on it. Threaded from
   *  `AppsConfig.escalatedPlan`; see that slot for why it is composition's. */
  escalatedPlan?: (appId: AppId, ctx: RunContext) => Promise<string | undefined>;
}

/**
 * Build contract §9.4 + the consumer voice law (design §3) — `forbidden` is
 * thrown for exactly one situation, and it is an ANSWERABLE one: the caller
 * provably sees the app and may not change it. The runtime's sentence names the
 * level and the app id ("editor access is required for app_7c2f…") because a
 * host developer reads it in a log; the MODEL relays what it is handed to a
 * person, so what it is handed here is the fork offer the level vocabulary
 * exists to make possible. The code is untouched: machines match on the code,
 * people read the message.
 */
// Deliberately DIRECTS rather than promises: there is no fork tool in this
// registry (make · rebase_pin · open · data_*), so a message saying "I
// will make you one" would have the model claim a capability it does not have.
const FORK_OFFER = "I can’t change the team’s copy of this app. Say so plainly, and offer them"
  + " their own copy instead — forking the app from its card gives them one I can change freely.";

/**
 * The `app` slot as a person says it: an app id, or the app's NAME.
 *
 * A fresh thread holds no ids — "add a weekly one to the transactions app" is
 * the whole ask, and until now it died on the way in, because `app` took an id
 * and nothing in this registry lists or searches. The aim already has a slot;
 * this is that slot understanding the name the user actually said.
 *
 * Exact name first, then case-insensitively, over THIS caller's own apps (the
 * same owned ∪ granted list every other door reads). Two apps of one name is a
 * question, never a coin toss: the candidates come back in the refusal so the
 * model can ask which one. And a ref that matches no name is handed on
 * untouched, so "no such app" and "you may not change that one" stay the
 * runtime's own sentences.
 */
const resolveAppRef = async (
  runtime: AppsRuntime,
  ref: string,
  ctx: RunContext,
): Promise<string> => {
  // An id is an id (core's own shape). Nothing is listed for the common path.
  if (appIdSchema.safeParse(ref).success) return ref;
  const apps = await runtime.list(ctx);
  const exact = apps.filter(({ name }) => name === ref);
  const matches = exact.length > 0
    ? exact
    : apps.filter(({ name }) => name.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return (matches[0] as AppDocument).id;
  if (matches.length > 1) {
    throw new VendoError(
      "validation",
      `More than one app is called "${ref}": ${matches.map(({ name, id }) => `${name} (${id})`).join(", ")}.`
      + " Ask which one they mean and pass that app's id.",
    );
  }
  return ref;
};

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


const errorOutcome = (error: unknown): ToolOutcome => {
  if (error instanceof VendoError) {
    return {
      status: "error",
      error: {
        code: error.code,
        message: error.code === "forbidden" ? FORK_OFFER : error.message,
      },
    };
  }
  return {
    status: "error",
    error: { code: "internal", message: error instanceof Error ? error.message : "unknown apps error" },
  };
};

/** 06-apps §§1,5 — unbound Vendo app capabilities; the umbrella binds this registry. */
export const createAgentTools = (
  runtime: AppsRuntime,
  dependencies: AgentToolsDataDependencies,
): ToolRegistry => ({
  async descriptors() {
    return structuredClone(agentToolDescriptors);
  },
  async execute(call, ctx: RunContext): Promise<ToolOutcome> {
    try {
      if (call.tool === VENDO_MAKE_TOOL) {
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
            console.warn(`[vendo] the ask was not recorded on ${appId}: ${
              error instanceof Error ? error.message : String(error)
            }`);
          });
        };
        if (app === undefined) {
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
              console.warn(`[vendo] the screen agent could not serve ${appId} — ${threw}`);
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
                say: `${stored.name} is on your screen.`,
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
          const created = await runtime.create({
            appId,
            prompt: ask,
            ...(plan === undefined ? {} : { plan }),
            // No `slot`: the claim went down at the mint above, which is the
            // same instant `create` would have made it for an id of its own.
            onUnsaved: (reason) => { unsaved = reason; },
            ...(stream === undefined ? {} : {
              onView: (part) => stream({ id: vendoViewStreamId(part.appId), part }),
            }),
          }, ctx);
          // An unsaved create has no row to remember onto; `remember` says so
          // and moves on, which is the same non-event every other failure is.
          await remember(created.id);
          // View-only (the store refused the write): the screen IS on the user's
          // page, so this is a success with a caveat, not a failure. Reporting it
          // as an error made the agent apologize for a rendered view and rebuild
          // it twice more — three cards, one prompt (live 2026-07-27). The
          // caveat rides `say`, which is the whole point of `say`: one true
          // sentence, and nothing to react to.
          return receipt({
            id: created.id,
            title: created.name,
            status: "ready",
            say: unsaved === undefined
              ? `${created.name} is on your screen.`
              : `${created.name} is on your screen, though I couldn't save it to your apps.`,
          });
        }
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
        const appId = await resolveAppRef(runtime, app, ctx);
        const result = await runtime.edit(appId, ask, ctx);
        // Recorded whether or not the change landed: the person DID ask this of
        // this app, and the next editor reading "asked for X, then asked for X
        // again, narrower" is reading the truth.
        await remember(appId);
        // Wave 9 — a ladder-authored automation raises its own card. Published
        // HERE, by the side that knows, rather than duck-typed out of this tool's
        // return value at the bridge: the receipt carries words only.
        if (result.automation !== undefined && stream !== undefined) {
          stream({
            id: `vendo-automation-${result.app.id}`,
            part: {
              type: "data-vendo-automation",
              appId: result.app.id,
              name: result.app.name,
              enabled: result.automation.enabled,
              ...(result.automation.trigger === undefined ? {} : { trigger: result.automation.trigger }),
              ...(result.app.description === undefined || result.app.description.length === 0
                ? {}
                : { description: result.app.description }),
              ...((result.automation.pendingGrants ?? []).length === 0
                ? {}
                : { pendingGrants: result.automation.pendingGrants!.length }),
            },
          });
        }
        return receipt({
          id: result.app.id,
          title: result.app.name,
          status: result.failure === undefined ? "ready" : "failed",
          say: result.failure === undefined
            ? `${result.app.name} is updated.`
            : `I couldn't make that change to ${result.app.name}.`,
        });
      }
      if (call.tool === "vendo_apps_rebase_pin") {
        const args = input(call.args, ["appId", "slot"]);
        const result = await runtime.pins.rebase({
          appId: args.appId as string,
          slot: args.slot as string,
        }, ctx);
        return { status: "ok", output: result as unknown as Json };
      }
      if (call.tool === "vendo_apps_open") {
        const args = input(call.args, ["appId"]);
        // The same aim as `vendo_make`'s `app`, because this is the door a model
        // holding only a name reaches for FIRST — and it used to answer
        // "no such app" while that app sat in the caller's own list.
        const appId = await resolveAppRef(runtime, args.appId as string, ctx);
        return { status: "ok", output: await runtime.open(appId, ctx) as unknown as Json };
      }
      if (call.tool === VENDO_APPS_PIN_TOOL) {
        const args = input(call.args, ["app", "slot"]);
        const appId = await resolveAppRef(runtime, args.app as string, ctx);
        const slot = args.slot as string;
        const { evicted } = await runtime.place({ app: appId, slot }, ctx);
        return {
          status: "ok",
          output: { app: appId, slot, ...(evicted === undefined ? {} : { evicted }) },
        };
      }
      if (call.tool === VENDO_APPS_UNPIN_TOOL) {
        const args = input(call.args, ["app", "slot"]);
        const appId = await resolveAppRef(runtime, args.app as string, ctx);
        const slot = args.slot as string;
        await runtime.unplace({ app: appId, slot }, ctx);
        return { status: "ok", output: { app: appId, slot } };
      }
      if (call.tool === "vendo_apps_data_list") {
        const args = input(call.args, ["appId", "collection"], ["refs", "limit", "cursor"]);
        const app = await dependencies.requireOwned(args.appId as string, ctx);
        const refs = optionalRefs(args.refs);
        const limit = optionalLimit(args.limit);
        if (args.cursor !== undefined && (typeof args.cursor !== "string" || args.cursor.trim() === "")) {
          throw new VendoError("validation", "cursor must be a non-empty string");
        }
        const query: RecordQuery = {
          ...(refs === undefined ? {} : { refs }),
          ...(limit === undefined ? {} : { limit }),
          ...(args.cursor === undefined ? {} : { cursor: args.cursor as string }),
        };
        return {
          status: "ok",
          output: await dependencies.data.records(app, args.collection as string).list(query) as unknown as Json,
        };
      }
      if (call.tool === "vendo_apps_data_put") {
        const args = input(call.args, ["appId", "collection", "id"], ["data", "refs"]);
        if (!Object.prototype.hasOwnProperty.call(args, "data") || args.data === undefined) {
          throw new VendoError("validation", "data is required");
        }
        const app = await dependencies.requireOwned(args.appId as string, ctx);
        const refs = optionalRefs(args.refs);
        const record = await dependencies.data.records(app, args.collection as string).put({
          id: args.id as string,
          data: args.data,
          ...(refs === undefined ? {} : { refs }),
        });
        return { status: "ok", output: record as unknown as Json };
      }
      if (call.tool === "vendo_apps_data_delete") {
        const args = input(call.args, ["appId", "collection", "id"]);
        const app = await dependencies.requireOwned(args.appId as string, ctx);
        await dependencies.data.records(app, args.collection as string).delete(args.id as string);
        return { status: "ok", output: { status: "ok" } };
      }
      return { status: "error", error: { code: "not-found", message: `Unknown tool: ${call.tool}` } };
    } catch (error) {
      return errorOutcome(error);
    }
  },
});
