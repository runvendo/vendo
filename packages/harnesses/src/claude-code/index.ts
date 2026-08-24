/**
 * `claudeCode()` — the Claude Agent SDK behind the frozen Harness contract.
 *
 * The flagship proof that "who thinks" is swappable: real bash hands over a
 * materialized workspace copy, a native session that survives across turns, and
 * NOT ONE new safety mechanism. Every tool call still lands in
 * `turn.tools.call()` — one guard, one audit row, one mirror, exactly like
 * `vendo()` — because the box's toolset is a projection, never an execution site.
 *
 * The ~250MB SDK never enters the host's node_modules on the sandbox path: it
 * lives in the box image, and this subpath is a thin driver. `machine: "local"`
 * loads it by dynamic import from an OPTIONAL peer.
 *
 * Read with: build contract §1 (the contract), §1.4 (approvals), §3.5
 * (materialization), and design §3 / §8 / §9.
 */
import {
  VENDO_MAKE_TOOL,
  VendoError,
  log,
  type BeatPhase,
  type Harness,
  type HarnessEvent,
  type Turn,
} from "@vendoai/core";
import type { BeatPhase as LoopBeatPhase, ClaudeTurnEvent } from "./claude-turn.js";
import type { UIMessage } from "ai";
import { z } from "zod";
import { defineHarness } from "../define.js";
import { harnessAdapters, type HarnessAdapters } from "../harness-sandbox.js";
import { checkoutWorkspace, type SyncFile } from "../materialize.js";
import type { SessionMachine } from "./machine.js";
import { localMachine } from "./local.js";
import { boxEgress, boxMachine, inferenceEnv, type SandboxAdapterLike } from "./box.js";

// The session machine's own seams, re-exported for the callers that drive it
// directly rather than through `claudeCode()`: the umbrella's live box proofs,
// and a host process that wants to reap idle conversation boxes on shutdown
// (`disposeLocalSessions` in ./local.js is the `machine: "local"` counterpart).
export {
  BOX_WORKSPACE_ROOT,
  boxEgress,
  boxMachine,
  disposeSessionMachines,
  inferenceEnv,
  type SandboxAdapterLike,
  type SandboxMachineLike,
} from "./box.js";
/** The bound a build's dead-man timer has to clear: what the box itself gives
 *  ONE message before giving up on it. */
export { MESSAGE_BUDGET_MS } from "./machine.js";

/** The knobs a TURN may still carry (harness-declared; see optionsSchema). */
export interface ClaudeCodeTurnOptions {
  maxTurns?: number;
}

/**
 * The beat phase union is declared TWICE, and this is what makes that safe.
 *
 * Core owns `BeatPhase` (contract §3.4). `claude-turn.ts` restates it
 * structurally because that file imports NOTHING — its module header explains
 * why: the emitted `dist/claude-turn.js` is copied verbatim into a machine image,
 * and a module that named its dependencies was reachable from every composed
 * host's build graph.
 *
 * The `yield event` below already compares the two unions, but only in ONE
 * direction: a mirror that is a SUBSET of core stays assignable, so a seventh
 * phase added to core would leave the box silently unable to ever emit it, with
 * nothing failing anywhere (verified: adding one to core left every typecheck
 * green). This map closes that direction — its keys are required by CORE's union
 * and its values are typed as the LOOP's, so drift either way fails here, by
 * name, instead of as an inference error 200 lines down.
 */
export const BEAT_PHASES: Record<BeatPhase, LoopBeatPhase> = {
  understanding: "understanding",
  planning: "planning",
  assembling: "assembling",
  building: "building",
  checking: "checking",
  finishing: "finishing",
};

/** v1 options, exactly (design §3): nothing else until asked. */
export interface ClaudeCodeOptions extends ClaudeCodeTurnOptions {
  /** Construction-time only (agents spec 2026-08-04 cut per-turn model/effort):
   *  which model thinks binds when the harness is built, never per request. */
  model?: string;
  effort?: "low" | "medium" | "high";
  /** Run the SDK on the host's own server instead of a sandbox. Never default. */
  machine?: "local";
  /**
   * Provider template the conversation box boots from; defaults to
   * `VENDO_BOX_TEMPLATE`. Construction-time like `machine`: which image a box
   * runs is a deployment decision, never a request's.
   *
   * Sandbox path only: `machine: "local"` has no box to template.
   */
  template?: string;
  /**
   * Extra outbound domains the box may reach, ADDED to the minimum set
   * ({@link boxEgress}). Bare hostnames, as `vendo.json`'s `egress` writes them.
   *
   * The box's outbound traffic is filtered against this list at the provider's
   * DOMAIN layer, so a host whose agent legitimately needs a third party — their
   * own API on another origin, an allowed vendor — names it here. (What that
   * filtering does and does not stop: see {@link boxEgress}.)
   * There is no approval flow on this list, unlike an app
   * document's `egress` (`egress-approval.ts`): that one is an ASK from generated
   * code, this one is the host developer's own source at boot, the same authority
   * that sets `implicitDomains`.
   *
   * Sandbox path only: `machine: "local"` has no network boundary to widen.
   */
  egress?: string[];
}

/**
 * Declared, then overridable per turn (design §3, "Options are declared").
 *
 * `machine` is deliberately NOT here. It is construction-time only
 * (`claudeCode({ machine: "local" })`): a per-turn override would let a wire
 * caller pull the ~250MB SDK onto the host's own server and run it there, which
 * is a deployment decision, never a request's. The compose gate reads the
 * constructor arg for the same reason.
 *
 * `egress` is absent for a harder version of the same reason: it IS the box's
 * network boundary, so a per-turn override would let request text — which is
 * where prompt injection lives — name the host it wants to be reachable.
 *
 * `model` and `effort` left too (agents spec 2026-08-04, feature cut): which
 * model thinks — and how hard — binds at construction, like every other
 * harness knob. The per-turn path was declared and never enforced, and a knob
 * that big must not ride request payloads.
 */
const optionsSchema = z.object({
  maxTurns: z.number().int().positive().optional(),
});

/** Host-side dependencies arrive by factory closure (design §3), which is how a
 *  host who did not wire `createVendo({ sandbox })` hands one straight to the
 *  harness. Composition fills the same slots through `provideHarnessAdapters`;
 *  an explicitly passed value always wins (the adapter rule). The three apps
 *  hooks are the app-document vocabulary this package no longer imports —
 *  `HOT_PATH_WATCH`/`hotPathAppId`, `validateWrittenApps`, `repairInstruction`
 *  in `@vendoai/apps`. Without them the driver still runs, minus the mid-turn
 *  hot-path sync and the validate gate ({@link warnNoAppsHooksOnce}). */
export interface ClaudeCodeDeps
  extends Pick<HarnessAdapters, "hotPaths" | "validateApps" | "repairInstruction"> {
  sandbox?: SandboxAdapterLike;
}

/** The plain text of one message, for the re-seed. Parts we cannot render as
 *  prose are deliberately dropped: a re-seed is a summary, never the raw wire. */
function textOf(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * What the SDK is asked this turn.
 *
 * Resuming a native session, the SDK already holds everything before now, so the
 * prompt is only what the user just said. Starting fresh — a first turn, or a
 * mid-conversation swap from `vendo()` — the thread is re-seeded from OUR
 * transcript, which is what lets the swap continue the conversation rather than
 * restart it. The truth is always ours (design §3, "Harness state").
 */
export function promptFor(messages: readonly UIMessage[], resuming: boolean): string {
  const latest = messages.at(-1);
  const spoken = latest === undefined ? "" : textOf(latest);
  if (resuming) return spoken === "" ? "Continue." : spoken;
  const earlier = messages.slice(0, -1)
    .map((message) => {
      const text = textOf(message);
      return text === "" ? "" : `${message.role === "user" ? "User" : "You"}: ${text}`;
    })
    .filter((line) => line !== "");
  if (earlier.length === 0) return spoken === "" ? "Continue." : spoken;
  return `Here is the conversation so far, so you can pick it up mid-thread:\n\n${earlier.join("\n\n")}\n\n`
    + `The user now says:\n\n${spoken}`;
}

/** `turn.state` — the opaque blob (§1.3). Ours to shape, nobody else's to read. */
interface ClaudeState {
  /**
   * The SDK's native session id.
   *
   * This is the WHOLE of our recovery story now. It used to sit beside a
   * snapshot ref and a control token, because a swept box could be woken; a
   * conversation box is destroyed instead, so a session id is only resumable
   * while the box that owns it is still up. On a fresh box the id is stale and
   * the thread re-seeds from OUR transcript — which is the truth anyway
   * (design §3, "Harness state").
   */
  sessionId?: string;
  /** How long our transcript was when this session last answered — the ONLY
   *  thing that makes a truncation detectable. */
  covers?: number;
}

/**
 * §1.3's prefix truncation: did the user throw away the answer this session still
 * remembers?
 *
 * `covers` counts the answering turn's INPUTS — its reply lands at transcript
 * index `covers` — so a history that did not GROW means that reply is gone. That
 * is a REGENERATE or a delete-from-here; a real mid-history edit never reaches
 * here, because the runtime already CLEARS the state for one (`classifyHistory`
 * calls a differing overlap an arbitrary edit).
 *
 * This replaced a rewind LEDGER (`rewindFor`, `resumeSessionAt`, per-message
 * checkpoint uuids, a 24-entry history). That machinery was dead: the box door
 * never read `payload.resumeAt` and a warm session never reopened, so a
 * regenerate left the discarded answer in the model's memory — the exact failure
 * it existed to prevent. Dropping the session and re-seeding from OUR transcript
 * is never wrong, only slower, and regenerate is the rare path.
 */
export function truncated(state: ClaudeState, messageCount: number): boolean {
  return state.covers !== undefined && messageCount <= state.covers;
}

const readState = (raw: string | undefined): ClaudeState => {
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as ClaudeState) : {};
  } catch {
    return {};
  }
};

/**
 * One door credential per CONVERSATION, held exactly as long as its machine is.
 *
 * Not per turn, because the session's `mcpServers` headers are fixed when the
 * SDK session opens and a warm machine never reopens. That is safe because the
 * credential's AUTHORITY is per turn regardless: it resolves to the turn in
 * flight on this thread and to nothing between turns (mcp/turn-credential.ts).
 * A machine that is not carrying a session is about to open a fresh one, so its
 * old credential is revoked here rather than left to the registry's idle sweep.
 */
const doorTokens = new Map<string, string>();

/**
 * A door nobody can dial is a deployment fact, not a per-turn event.
 *
 * Only the LOCAL leg reaches this: a box with no origin refuses the turn
 * outright (below), which is loud by itself. A local thinker keeps running —
 * a workspace-only assistant is a legitimate deployment — so without this the
 * operator would have no signal at all that their agent lost every product
 * action. That silence is what door-internal's first round shipped.
 */
let noOriginWarned = false;
function warnNoOriginOnce(): void {
  if (noOriginWarned) return;
  noOriginWarned = true;
  log({
    code: "harnesses.claude-code-no-origin",
    level: "error",
    message:
      "[vendo] claudeCode() has no origin to reach the MCP door, so this agent has "
      + "NONE of your product's actions — only its own workspace. Set VENDO_BASE_URL "
      + "(or `mcp: { baseUrl }`) to an origin this machine can reach. In development "
      + "the wire learns its own LOOPBACK origin instead, so seeing this locally means "
      + "NODE_ENV is not \"development\" or the host is not served over localhost.",
  });
}

/**
 * Is the door THERE? One request of exactly the shape the SDK's MCP client is
 * about to make, and the two answers that mean it is not: no answer at all
 * (refused, DNS failure, timeout — anything that makes `fetch` throw), or the
 * origin itself saying this path does not exist.
 *
 * Any HTTP status other than 404 is the door WORKING. A 401 especially: the
 * credential that authenticates it is not minted until further down, so an
 * unauthenticated probe is supposed to be turned away.
 *
 * On the TURN's signal, because this is the first thing a turn does and a door
 * that accepts the connection but never replies holds it open all the way to
 * undici's 300s headers timeout — a cancelled turn would sit here long after
 * the person who cancelled it was gone. The caller reads the signal again
 * before blaming the door: "nothing answered" and "we stopped asking" are not
 * the same fact, and only one of them is a misconfiguration.
 */
async function doorAnswers(url: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(url, { method: "POST", signal }).catch(() => undefined);
  return response !== undefined && response.status !== 404;
}

/**
 * A runtime driven BARE — no composition filled the apps hooks and the host
 * passed none — loses the mid-turn hot-path sync (skeletons paint at turn end
 * instead of in seconds) and the end-of-turn validate gate. A deployment fact,
 * said once, same shape as {@link warnNoOriginOnce}: composed paths always
 * inject the real implementations, so this only reaches a host driving the
 * runtime directly.
 */
let noAppsHooksWarned = false;
function warnNoAppsHooksOnce(): void {
  if (noAppsHooksWarned) return;
  noAppsHooksWarned = true;
  log({
    code: "harnesses.claude-code-no-apps-hooks",
    level: "error",
    message:
      "[vendo] claudeCode() is running without the apps hooks (hotPaths / validateApps / "
      + "repairInstruction), so mid-turn hot-path sync and the finish-line validate gate are "
      + "OFF. Compose through createVendo/createAgent to get them, or pass them to claudeCode() "
      + "directly.",
  });
}

/** A callback-driven producer, consumed by the generator that must `yield`. */
function eventQueue<T>() {
  const buffered: T[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  return {
    push(value: T) {
      buffered.push(value);
      wake?.();
    },
    close() {
      done = true;
      wake?.();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        while (buffered.length > 0) yield buffered.shift()!;
        if (done) return;
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    },
  };
}

export function claudeCode(
  options: ClaudeCodeOptions & ClaudeCodeDeps = {},
): Harness<ClaudeCodeTurnOptions> {
  const harness: Harness<ClaudeCodeTurnOptions> = defineHarness<ClaudeCodeTurnOptions>({
    name: "claude-code",
    optionsSchema: optionsSchema as never,
    // The factory reads its OWN arg; the compose gate stays dumb (§9: a
    // spawned-CLI harness with no machine to live on is a BOOT error).
    // `toolDoor` on BOTH legs: the SDK session reaches the host's tools over
    // remote MCP whether it runs in a box or as a subprocess here, so this is
    // what makes composition mount a door with no `mcp` option in sight.
    requires: { toolDoor: true, ...(options.machine === "local" ? {} : { sandbox: true }) },
    // Design §D2/§D4. UNCURATED: this model reads a large listing natively, so a
    // loadout that hides tools behind a search is friction it does not need — the
    // ctx safety projection still decides what may be projected at all. And app
    // generation leaves this surface: the model builds and edits apps by writing
    // `app.tsx` with its own hands, so the one engine tool is
    // withheld rather than left as a second, coin-flip path to the same outcome.
    // Lifecycle tools (`vendo_apps_open`, the pin and data verbs) stay.
    toolSurface: { curated: false, withhold: [VENDO_MAKE_TOOL] },

    async *run(turn: Turn<ClaudeCodeTurnOptions>): AsyncGenerator<HarnessEvent, void, void> {
      // Everything about the brain — model, effort, machine, template, egress —
      // is the CONSTRUCTOR's; a turn may only bound its own length.
      const resolved = {
        ...options,
        ...(turn.options?.maxTurns === undefined ? {} : { maxTurns: turn.options.maxTurns }),
      };
      const state = readState(turn.state.get());
      const composed = harnessAdapters(harness);

      // The apps hooks — the hot-path vocabulary and the validate gate, which
      // used to be value imports from `@vendoai/apps` and now arrive injected:
      // the constructor's own arg wins, composition fills what the host left
      // unset (the adapter rule). A runtime driven bare has neither, keeps
      // running, and the operator hears exactly what it lost, once.
      const hotPaths = options.hotPaths ?? composed.hotPaths;
      const validateApps = options.validateApps ?? composed.validateApps;
      const repairInstruction = options.repairInstruction ?? composed.repairInstruction;
      if (hotPaths === undefined || validateApps === undefined || repairInstruction === undefined) {
        warnNoAppsHooksOnce();
      }

      // The DOOR is resolved before the machine, because its origin is part of
      // the box's network boundary and that is fixed at create. Only its
      // deployment half is read here; the per-conversation credential is minted
      // below, once there is a machine to say whether it is carrying a session.
      const doorPort = composed.toolDoor;
      const doorUrl = doorPort?.url;
      if (doorPort !== undefined && doorUrl === undefined
        && doorPort.autoMounted !== true && resolved.machine !== "local") {
        // A door the HOST asked for, and no BOX can reach it. Loud for the
        // operator, because only they can fix it, and one plain sentence for
        // the user — the same shape as the missing-sandbox branch below.
        // Running on anyway would hand the model a workspace and no hands,
        // which is the polite-refusal-at-HTTP-200 failure this codebase
        // refuses to ship. Decided HERE, before the machine exists, so a
        // doomed turn never pays for a sandbox boot.
        //
        // `autoMounted` is what keeps this scoped to a real misconfiguration.
        // Composition mounts the internal door whenever a harness declares
        // `requires.toolDoor`, which `claudeCode()` now does unconditionally —
        // so without that check this branch also swallows every workspace-only
        // deployment that simply never named an origin, which is a supported
        // shape and not an error. Those fall through to the warning below.
        log({
          code: "harnesses.claude-code-no-mcp-door",
          level: "error",
          message:
            "[vendo] claudeCode() cannot reach the MCP door: set VENDO_BASE_URL (or "
            + "`mcp: { baseUrl }`) to the deployment's public origin. The agent's tools "
            + "travel over that door, so without it the model has no way to act.",
        });
        yield { type: "error", message: "I can't use this product's actions right now." };
        return;
      }
      // A LOCAL thinker with no origin to dial is not a misconfiguration to
      // refuse: nothing was set wrong, the deployment simply never named an
      // origin, and a subprocess on this machine is a legitimate
      // workspace-only assistant. The operator still hears about it once,
      // because they are the only one who can change it and the user must
      // never be quietly under-served.
      if (doorPort !== undefined && doorUrl === undefined) warnNoOriginOnce();

      // The other half of that refusal, and the one it could not see: a door
      // that IS named and is not THERE. The SDK swallows a failed MCP connect,
      // so a dead door here opens a session with zero host tools and lets the
      // model answer anyway — the same polite-refusal-at-HTTP-200, reached
      // through a url that merely looks configured. A typo'd host and a host
      // that is down are the same failure to the customer as a wrong path, so
      // all of them refuse. Both legs, before the machine exists, so a doomed
      // turn never pays for a sandbox boot.
      if (doorUrl !== undefined && !await doorAnswers(doorUrl, turn.signal) && !turn.signal.aborted) {
        throw new VendoError(
          "unavailable",
          `claudeCode() found no MCP door at ${doorUrl}. Every one of this product's `
          + "actions travels over that door, so the turn would run with none. Check that "
          + "VENDO_BASE_URL (or `mcp: { baseUrl }`) names the FULL public base this "
          + "deployment is served under — path prefix included.",
        );
      }

      const boxEnv = inferenceEnv();

      // The MACHINE comes next, because whether it is warm decides what the
      // checkout may assume: a warm machine's disk is the baseline, a fresh one
      // is about to be handed the store's own copy.
      let machine: SessionMachine;
      if (resolved.machine === "local") {
        machine = await localMachine({ threadId: threadOf(turn), env: boxEnv });
      } else {
        const sandbox = (options.sandbox ?? composed.sandbox) as
          | SandboxAdapterLike
          | undefined;
        if (sandbox === undefined) {
          // On the composed path server.ts now threads the gate-checked
          // adapter into the slot, so gate-pass implies slot-filled there.
          // Still reachable by a host driving the runtime directly without a
          // sandbox — and it has to be loud for the operator and quiet for
          // the user.
          log({
            code: "harnesses.claude-code-no-sandbox",
            level: "error",
            message:
              "[vendo] claudeCode() has no sandbox adapter. Hand it one directly — "
              + "`harness: claudeCode({ sandbox: e2bSandbox({ apiKey }) })` — or pass "
              + "`sandbox` into createHarnessTurns so composition fills the slot.",
          });
          yield { type: "error", message: "I can't run right now — this assistant is missing its workspace machine." };
          return;
        }
        machine = await boxMachine({
          sandbox,
          threadId: threadOf(turn),
          env: boxEnv,
          allowedDomains: boxEgress(boxEnv, doorPort?.url, resolved.egress),
          ...(resolved.template === undefined ? {} : { template: resolved.template }),
        });
      }

      // A WARM machine diffs against what its own disk holds (`machine.tree`),
      // never against a fresh store read: the store may have moved underneath it
      // (another thread of the same user, an app tool, an automation) and the
      // box's stale copy must not be written back over the newer state. A FRESH
      // machine passes nothing, so the baseline is derived here and is exactly
      // what materialize is about to put on its disk.
      const checkout = await checkoutWorkspace(
        turn.workspace,
        machine.tree,
        !machine.carriesSession,
        // The injected hot-path vocabulary decides what `syncHot` may land; no
        // vocabulary, nothing is hot — and nothing collects mid-turn either.
        (path) => hotPaths?.appId(path) !== undefined,
      );

      // The host's MCP door — the ONLY way this harness reaches the world now
      // that the in-process projection is gone (10-mcp §3b). Composition mounts
      // one for us (`requires.toolDoor`), so an empty slot means the runtime is
      // being driven directly, without one: the box's own hands and nothing
      // else. Its ORIGIN was read above — the door decision and the egress
      // boundary are both fixed before the machine exists; only its credential
      // is minted here, because only a machine can say whether it already
      // carries a session.
      let door: { url: string; token: string } | undefined;
      if (doorPort !== undefined && doorUrl !== undefined) {
        const conversation = threadOf(turn);
        if (!machine.carriesSession) {
          const previous = doorTokens.get(conversation);
          if (previous !== undefined) doorPort.revoke(previous);
          doorTokens.delete(conversation);
        }
        let token = doorTokens.get(conversation);
        if (token === undefined) {
          token = doorPort.mint(conversation);
          if (token !== undefined) doorTokens.set(conversation, token);
        }
        if (token !== undefined) door = { url: doorUrl, token };
      }

      /** One sync at a time: the façade stages in memory, and two overlapping
       *  commits would race each other's staging set. */
      let syncing: Promise<unknown> = Promise.resolve();
      const serialize = <T>(work: () => Promise<T>): Promise<T> => {
        const next = syncing.then(work, work);
        syncing = next.catch(() => undefined);
        return next;
      };

      // Two reasons a live session cannot be continued. A machine whose disk does
      // not carry it cannot resume it at all; and a TRUNCATION means the session
      // remembers an answer the user threw away, so it has to go. Either way the
      // honest move is to re-seed from OUR transcript, which is the truth anyway.
      const stale = truncated(state, turn.messages.length);
      let sessionId = machine.carriesSession && !stale ? state.sessionId : undefined;
      let finished = false;
      /** Whether the box's disk is KNOWN to hold this checkout — a warm one
       *  already does, a fresh one only once materialize lands. What the
       *  sync-back below needs before it may read the disk as a statement. */
      let materialized = machine.carriesSession;

      try {
        // ONLY on a machine that is not already carrying this conversation. A warm
        // box's disk IS the working copy: re-materializing between messages would
        // reset the tree the live session is holding open, which is the one thing
        // "one box per conversation" exists to prevent.
        if (!machine.carriesSession) {
          await machine.materialize(checkout.files);
          materialized = true;
        }

        /** Every hot path this turn actually LANDED in the store — what the
         *  validate gate below checks. Accumulated from the syncs' own answers
         *  rather than from the box's disk, because a path the sync refused (a
         *  revoked org grant) is not this turn's work to gate. */
        const landed = new Set<string>();

        /** Sync on WRITE, not on a tick — the native PostToolUse hook drives this.
         *  Still by SHAPE, because the app whose plan lands first may have an id
         *  the turn only just invented. A no-op on the bare path: no vocabulary,
         *  no hot set to collect. */
        const syncHot = async (): Promise<void> => {
          if (hotPaths === undefined) return;
          const hot = await machine.collect(hotPaths.watch);
          for (const path of await checkout.syncHot(hot)) landed.add(path);
        };

        /** The barrier the write hook awaits. It must NOT resolve unless the write
         *  actually reached the store: a swallowed failure here puts the model
         *  back to racing its own write, silently, which is the worse half of the
         *  bug this barrier exists for. The caller says so in band. */
        const syncHotNow = async (): Promise<void> => {
          if (finished) return;
          await serialize(syncHot);
        };

        // `Turn.skills` finally reaches this harness. Before cc-native the pack
        // skills were materialized onto the box's disk and NOTHING pointed the
        // model at them — they were files it might stumble on. Naming them here
        // is what turns the `/host` mount into a native plugin, and naming them
        // rather than saying "all" is what stops the MACHINE's own skills (an
        // operator's ~/.claude/skills, on the local path) from joining the set.
        const skillNames = (await turn.skills.list().catch(() => [])).map((skill) => skill.name);
        // Mid-build steering (§10.2). Registered BEFORE the send so nothing typed
        // early is lost, and it is the machine's own answer that travels back —
        // this harness decides nothing about whether the words fit. Registered
        // ONCE here, outside `round`, so the validate fix round below does not
        // double-subscribe to the same steer channel.
        turn.onSteer?.((text) => machine.steer(text));
        /**
         * One exchange with the session: send, drain what it emits, wait for it.
         *
         * Extracted because the validate gate below needs a SECOND one, and a fix
         * round that went through different code than the turn would be a second
         * way to drive the same session.
         */
        const round = async function* (prompt: string): AsyncGenerator<HarnessEvent, void, void> {
          const events = eventQueue<ClaudeTurnEvent>();
          const running = machine.send({
            prompt,
            // The host's composed brief, WHOLE and ALONE: what the box thinks with
            // is the host's prompt seam, never lines this harness appends after it.
            systemPrompt: turn.system ?? "",
            ...(door === undefined ? {} : { toolDoor: door }),
            ...(resolved.model === undefined ? {} : { model: resolved.model }),
            ...(resolved.effort === undefined ? {} : { effort: resolved.effort }),
            ...(resolved.maxTurns === undefined ? {} : { maxTurns: resolved.maxTurns }),
            ...(sessionId === undefined ? {} : { resume: sessionId }),
            // A truncation on a WARM machine has to close the session it is holding
            // open, or the model keeps the answer the user deleted.
            ...(stale && machine.carriesSession ? { reopen: true } : {}),
            // The `/host` mount doubles as the SDK plugin root, so the pack skills
            // already on this disk are discovered natively — no projection. No
            // skills, no plugin: an empty plugin is a directory nobody reads.
            ...(skillNames.length === 0
              ? {}
              : { pluginPath: machine.pluginPath, skillNames }),
            emit: (event) => events.push(event),
            // No hook without a vocabulary: a wrote-event with nothing to
            // collect would round-trip the machine for an empty diff.
            ...(hotPaths === undefined ? {} : { onFileWritten: () => syncHotNow() }),
            signal: turn.signal,
          }).then(() => events.close(), (error: unknown) => {
            // The thinker failed; the user hears one plain sentence and the turn
            // still lands whatever work reached the disk.
            log({
              code: "harnesses.claude-code-turn-failed",
              level: "error",
              message: "[vendo] claude-code turn failed",
              data: { error },
            });
            events.push({ type: "error", message: "Something went wrong while I was working on that." });
            events.close();
          });

          for await (const event of events.drain()) {
            if (event.type === "session") {
              sessionId = event.sessionId;
              continue;
            }
            yield event;
          }
          await running;
        };

        yield* round(promptFor(turn.messages, sessionId !== undefined));

        /**
         * VALIDATE MUST PASS BEFORE DONE — blueprint §7.1 item 4.
         *
         * The verb was registered, on this harness's surface, and taught by the
         * building-apps skill; whether the model called it was the model's
         * business. A builder that skipped it reported success over a broken app,
         * and the only thing that noticed was the paint seam declining to paint —
         * which from the model's side is silence. So the loop asks, with the SAME
         * registered verb through the same guarded path.
         *
         * ONE round: being shown exactly what is wrong fixes it on the first try or
         * not at all, and a second round is the person waiting longer for the same
         * answer. Whatever survives it is reported as it stands — the seam already
         * refuses to paint a lie, so an unfixed app costs a screen, never the truth.
         *
         * The gate itself is INJECTED (`validateApps` + `repairInstruction`) —
         * every composed path supplies the real one; a bare runtime has none,
         * skips the round, and was warned above.
         */
        if (!turn.signal.aborted && validateApps !== undefined && repairInstruction !== undefined) {
          await serialize(syncHot).catch(() => undefined);
          const failures = await validateApps({
            tools: turn.tools,
            paths: [...landed],
            // …AND the reviewer, on whatever passed the mechanical half. This is
            // the turn boundary, so every app here is finished: the one place a
            // build can be judged for invented data and headlines that contradict
            // their own rows, whether or not the builder thought to ask.
            review: true,
          });
          const instruction = repairInstruction(failures);
          if (instruction !== undefined) yield* round(instruction);
        }
      } finally {
        finished = true;
        // Turn end: the whole writable tree, deletions included (§3.5).
        //
        // A machine that died mid-turn cannot be read back, and an EMPTY read is
        // not the same fact as "the user deleted everything" — syncing one as the
        // other would erase the workspace on every dead box. No read, no sync:
        // the store keeps what it had and the next turn recovers on a fresh
        // machine, which is exactly what the kill-mid-turn law asks for.
        //
        // A machine that never RECEIVED the workspace is that same fact from the
        // other end, and the more dangerous one: the box answers the read
        // honestly, and its honest answer is an empty tree. Read as a sync-back
        // it deletes every baseline path — the whole workspace — on a materialize
        // that died before it landed. No disk of ours, nothing it holds or lacks
        // is news about the store.
        let collected: SyncFile[] | undefined;
        try {
          if (materialized) collected = await machine.collect();
          else {
            log({
              code: "harnesses.claude-code-workspace-not-materialized",
              level: "error",
              message: "[vendo] claude-code: the box never received the workspace; nothing is synced back",
            });
          }
        } catch (error) {
          log({
            code: "harnesses.claude-code-workspace-read-failed",
            level: "error",
            message: "[vendo] claude-code could not read the workspace back",
            data: { error },
          });
        }
        if (collected !== undefined) {
          const files = collected;
          await serialize(() => checkout.syncAll(files)).catch((error: unknown) => {
            log({
              code: "harnesses.claude-code-sync-back-failed",
              level: "error",
              message: "[vendo] claude-code sync-back failed",
              data: { error },
            });
          });
        }
        try {
          await machine.release();
        } catch {
          // A machine we cannot release is the box map's problem, never the turn's.
        }
        const next: ClaudeState = {
          ...(sessionId === undefined ? {} : { sessionId, covers: turn.messages.length }),
        };
        if (next.sessionId === undefined) turn.state.clear();
        else turn.state.set(JSON.stringify(next));
      }
    },
  });
  return harness;
}

/**
 * The thread this turn belongs to — the session machine's pool key.
 *
 * `Turn.threadId` (contract §1, amendment 2026-08-01) is the answer on every
 * composed path — the field is required, so the fallbacks are unreachable from
 * typed callers and exist only for a turn hand-rolled outside the type system:
 * first message id (stable for the life of one thread,
 * unguessable outside it), else a per-turn random key — sharing a machine
 * (and therefore a native session and a workspace copy) between two
 * conversations because both happened to have no identity is the one outcome
 * that must never happen.
 */
function threadOf(turn: Turn<ClaudeCodeTurnOptions>): string {
  const named: unknown = turn.threadId;
  if (typeof named === "string" && named !== "") return named;
  const first = turn.messages[0]?.id;
  if (typeof first === "string" && first !== "") return first;
  return `anon_${globalThis.crypto.randomUUID()}`;
}

