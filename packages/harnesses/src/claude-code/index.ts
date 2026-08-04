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
  VENDO_APPS_CREATE_TOOL,
  VENDO_APPS_EDIT_TOOL,
  type Harness,
  type HarnessEvent,
  type Turn,
} from "@vendoai/core";
import type { ClaudeTurnEvent } from "@vendoai/apps/claude-turn";
import type { UIMessage } from "ai";
import { z } from "zod";
import { defineHarness } from "../define.js";
import { harnessAdapters, type ToolDoorPort } from "../harness-sandbox.js";
import { checkoutWorkspace, type SyncFile } from "../materialize.js";
import { HOT_PATH_WATCH } from "../render-seam.js";
import type { SessionMachine } from "./machine.js";
import { localMachine } from "./local.js";
import { boxMachine, type SandboxAdapterLike } from "./box.js";

/** v1 options, exactly (design §3): nothing else until asked. */
export interface ClaudeCodeOptions {
  model?: string;
  effort?: "low" | "medium" | "high";
  maxTurns?: number;
  /** Run the SDK on the host's own server instead of a sandbox. Never default. */
  machine?: "local";
  /**
   * Extra outbound domains the box may reach, ADDED to the minimum set
   * ({@link boxEgress}). Bare hostnames, as `vendo.json`'s `egress` writes them.
   *
   * The box's outbound traffic is filtered against this list at the provider's
   * DOMAIN layer, so a host whose agent legitimately needs a third party — their
   * own API on another origin, an allowed vendor — names it here. (What that
   * filtering does and does not stop: `docs/verification/box-egress/README.md`.)
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
 */
const optionsSchema = z.object({
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
  maxTurns: z.number().int().positive().optional(),
});

/** Host-side dependencies arrive by factory closure (design §3), which is how a
 *  host who did not wire `createVendo({ sandbox })` hands one straight to the
 *  harness. Composition fills the same slot through `provideHarnessAdapters`. */
export interface ClaudeCodeDeps {
  sandbox?: SandboxAdapterLike;
}

/** The recorded v0 inference exception (design §9): a boxed harness must reach a
 *  model to think, and that is the ONLY credential in the machine. */
export function inferenceEnv(): Record<string, string> {
  const source = globalThis.process?.env ?? {};
  const key = source["ANTHROPIC_API_KEY"] ?? source["VENDO_INFERENCE_KEY"];
  const url = source["ANTHROPIC_BASE_URL"] ?? source["VENDO_INFERENCE_URL"];
  const env: Record<string, string> = {
    // Nothing the CLI reaches for on the side: its telemetry and update hosts are
    // not on the box's allowlist (`boxEgress` below), so those calls fail rather
    // than answer — and a stalled one is a hung turn.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  if (key !== undefined && key !== "") env["ANTHROPIC_API_KEY"] = key;
  if (url !== undefined && url !== "") {
    env["ANTHROPIC_BASE_URL"] = url.replace(/\/+$/, "").replace(/\/v1$/, "");
  }
  return env;
}

/** The host the Agent SDK talks to when nothing overrides `ANTHROPIC_BASE_URL`. */
const DEFAULT_INFERENCE_HOST = "api.anthropic.com";

/** Domains compare case-insensitively and may carry stray spacing — the same
 *  normalization `normalizeEgressDomain` applies to a declaration. */
const normalizeDomain = (domain: string): string => domain.trim().toLowerCase();

const hostOf = (url: string | undefined): string | undefined => {
  if (url === undefined || url === "") return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

/**
 * The conversational box's outbound allowlist — the ONE place its network
 * boundary is assembled.
 *
 * Same shape as the served-app machine's (`boxAllowlist` in `@vendoai/apps`
 * `egress-approval.ts`): the box's OWN skin rides unconditionally, and
 * everything else is filtered out at the provider's DOMAIN layer.
 *
 * Read `docs/verification/box-egress/README.md` before relying on that for
 * anything: the filtering is real against ordinary clients and is BYPASSABLE by
 * a client that omits SNI (`openssl s_client -noservername` reaches arbitrary
 * IPs even under an empty list — measured). It is a provider-level gap this
 * repo cannot close. So this list raises the cost of exfiltration and stops
 * every ordinary client; it does not make the box unable to reach the network.
 *
 * Two skin entries, because a session box needs exactly two things to function:
 *
 *   1. the INFERENCE host — the SDK runs the model from inside the box, so a box
 *      that cannot reach it cannot think. Read off the env the box is actually
 *      handed, never guessed, so a managed-inference gateway
 *      (`VENDO_INFERENCE_URL` → `ANTHROPIC_BASE_URL`) is allowed and
 *      `api.anthropic.com` is not.
 *   2. the DOOR origin — every host tool travels the host's MCP door now
 *      (10-mcp §3b), so this is what replaced "the box holds nothing and reaches
 *      nothing". Per DEPLOYMENT, so it arrives from composition's `toolDoor`
 *      rather than being written down here.
 *
 * Nothing else: no npm registry, no telemetry, no update endpoint. The SDK is
 * baked into the machine image, and the CLI's side traffic is switched off in
 * `inferenceEnv()`.
 */
export function boxEgress(
  inference: Record<string, string>,
  doorUrl: string | undefined,
  extra: readonly string[] = [],
): string[] {
  const domains = [
    hostOf(inference["ANTHROPIC_BASE_URL"]) ?? DEFAULT_INFERENCE_HOST,
    hostOf(doorUrl),
    ...extra.map(normalizeDomain),
  ].filter((domain): domain is string => domain !== undefined && domain !== "");
  return [...new Set(domains)];
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

/**
 * The few lines the co-trained preset does NOT already know: where it is, who it
 * is talking to, and which hands touch reality.
 *
 * This replaced a ~14-line wall that re-explained the mount layout, the copy
 * semantics, the save timing and the refusal etiquette. Claude Code already knows
 * how to work in a directory — that is what the preset IS. What it cannot know is
 * the EMBEDDING, so that is all this says.
 */
function embeddingBrief(root: string): string {
  return `\n\nYou are embedded in this product, talking to one of its customers — plain language, no file paths, no tool names.`
    + `\n\nTheir files are in ${root}. Real-world actions — the product's own operations, their data — are the \`vendo\` tools;`
    + ` if one comes back refused, say so plainly and move on.`
    + ` Anything they want to look at, track, or keep using is an app you build in \`app.vendo\` —`
    + ` the \`building-apps\` skill is the manual.`
    + ` This session stays open for the whole conversation, so what you already read and built is still here.`;
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
 * flight on this thread and to nothing between turns (`turn-credentials.ts`).
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
  console.error(
    "[vendo] claudeCode() has no origin to reach the MCP door, so this agent has "
    + "NONE of your product's actions — only its own workspace. Set VENDO_BASE_URL "
    + "(or `mcp: { baseUrl }`) to an origin this machine can reach. In development "
    + "the wire learns its own LOOPBACK origin instead, so seeing this locally means "
    + "NODE_ENV is not \"development\" or the host is not served over localhost.",
  );
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
): Harness<ClaudeCodeOptions> {
  const harness: Harness<ClaudeCodeOptions> = defineHarness<ClaudeCodeOptions>({
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
    // `plan.vendo` / `app.vendo` with its own hands, so the two engine tools are
    // withheld rather than left as a second, coin-flip path to the same outcome.
    // Lifecycle tools (`vendo_apps_open`, the pin and data verbs) stay.
    toolSurface: { curated: false, withhold: [VENDO_APPS_CREATE_TOOL, VENDO_APPS_EDIT_TOOL] },

    async *run(turn: Turn<ClaudeCodeOptions>): AsyncGenerator<HarnessEvent, void, void> {
      // Per-turn options may override the model knobs and NOTHING else: `machine`
      // is read off the constructor, so a request can never move the SDK onto the
      // host's server.
      const resolved = {
        ...options,
        ...(turn.options ?? {}),
        machine: options.machine,
        egress: options.egress,
      };
      const state = readState(turn.state.get());

      // The DOOR is resolved before the machine, because its origin is part of
      // the box's network boundary and that is fixed at create. Only its
      // deployment half is read here; the per-conversation credential is minted
      // below, once there is a machine to say whether it is carrying a session.
      const doorPort = harnessAdapters(harness).toolDoor as ToolDoorPort | undefined;
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
        console.error(
          "[vendo] claudeCode() cannot reach the MCP door: set VENDO_BASE_URL (or "
          + "`mcp: { baseUrl }`) to the deployment's public origin. The agent's tools "
          + "travel over that door, so without it the model has no way to act.",
        );
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

      const boxEnv = inferenceEnv();

      // The MACHINE comes next, because whether it is warm decides what the
      // checkout may assume: a warm machine's disk is the baseline, a fresh one
      // is about to be handed the store's own copy.
      let machine: SessionMachine;
      if (resolved.machine === "local") {
        machine = await localMachine({ threadId: threadOf(turn), env: boxEnv });
      } else {
        const sandbox = (options.sandbox ?? harnessAdapters(harness).sandbox) as
          | SandboxAdapterLike
          | undefined;
        if (sandbox === undefined) {
          // On the composed path server.ts now threads the gate-checked
          // adapter into the slot, so gate-pass implies slot-filled there.
          // Still reachable by a host driving the runtime directly without a
          // sandbox — and it has to be loud for the operator and quiet for
          // the user.
          console.error(
            "[vendo] claudeCode() has no sandbox adapter. Hand it one directly — "
            + "`harness: claudeCode({ sandbox: e2bSandbox({ apiKey }) })` — or pass "
            + "`sandbox` into createHarnessTurns so composition fills the slot.",
          );
          yield { type: "error", message: "I can't run right now — this assistant is missing its workspace machine." };
          return;
        }
        machine = await boxMachine({
          sandbox,
          threadId: threadOf(turn),
          env: boxEnv,
          allowedDomains: boxEgress(boxEnv, doorPort?.url, resolved.egress),
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

      const events = eventQueue<ClaudeTurnEvent>();
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

      try {
        // ONLY on a machine that is not already carrying this conversation. A warm
        // box's disk IS the working copy: re-materializing between messages would
        // reset the tree the live session is holding open, which is the one thing
        // "one box per conversation" exists to prevent.
        if (!machine.carriesSession) await machine.materialize(checkout.files);

        /** Sync on WRITE, not on a tick — the native PostToolUse hook drives this.
         *  Still by SHAPE, because the app whose plan lands first may have an id
         *  the turn only just invented. */
        const syncHotNow = (): void => {
          if (finished) return;
          void serialize(async () => {
            const hot = await machine.collect(HOT_PATH_WATCH);
            await checkout.syncHot(hot);
          }).catch(() => undefined);
        };

        // `Turn.skills` finally reaches this harness. Before cc-native the pack
        // skills were materialized onto the box's disk and NOTHING pointed the
        // model at them — they were files it might stumble on. Naming them here
        // is what turns the `/host` mount into a native plugin, and naming them
        // rather than saying "all" is what stops the MACHINE's own skills (an
        // operator's ~/.claude/skills, on the local path) from joining the set.
        const skillNames = (await turn.skills.list().catch(() => [])).map((skill) => skill.name);
        const running = machine.send({
          prompt: promptFor(turn.messages, sessionId !== undefined),
          systemPrompt: `${turn.system ?? ""}${embeddingBrief(rootHintFor(resolved))}`,
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
          onFileWritten: () => syncHotNow(),
          signal: turn.signal,
        }).then(() => events.close(), (error: unknown) => {
          // The thinker failed; the user hears one plain sentence and the turn
          // still lands whatever work reached the disk.
          console.error("[vendo] claude-code turn failed", error);
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
      } finally {
        finished = true;
        // Turn end: the whole writable tree, deletions included (§3.5).
        //
        // A machine that died mid-turn cannot be read back, and an EMPTY read is
        // not the same fact as "the user deleted everything" — syncing one as the
        // other would erase the workspace on every dead box. No read, no sync:
        // the store keeps what it had and the next turn recovers on a fresh
        // machine, which is exactly what the kill-mid-turn law asks for.
        let collected: SyncFile[] | undefined;
        try {
          collected = await machine.collect();
        } catch (error) {
          console.error("[vendo] claude-code could not read the workspace back", error);
        }
        if (collected !== undefined) {
          const files = collected;
          await serialize(() => checkout.syncAll(files)).catch((error: unknown) => {
            console.error("[vendo] claude-code sync-back failed", error);
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
function threadOf(turn: Turn<ClaudeCodeOptions>): string {
  const named: unknown = turn.threadId;
  if (typeof named === "string" && named !== "") return named;
  const first = turn.messages[0]?.id;
  if (typeof first === "string" && first !== "") return first;
  return `anon_${globalThis.crypto.randomUUID()}`;
}

/** What the workspace brief calls the root. The box path pins it; local mints a
 *  temp dir, and naming it exactly is not worth a round trip. */
const rootHintFor = (resolved: ClaudeCodeOptions): string =>
  resolved.machine === "local" ? "your working directory" : "/workspace";

