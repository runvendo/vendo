/**
 * ONE Claude Agent SDK session, port-injected — wave 2 lane E, rewritten by
 * door-ctx.
 *
 * This module is the SDK loop for `claudeCode()`, and it has TWO homes on
 * purpose:
 *
 *   - inside the box, copied into the template as `/opt/vendo-box/claude-turn.mjs`
 *     (`build-template.mjs`), driven by the supervisor's session routes;
 *   - on the host, imported from `dist` for `machine: "local"`.
 *
 * **The tools are the HOST's own MCP door now.** They used to be an in-process
 * MCP server this file BUILT — every handler round-tripping to the host over an
 * inverted HTTP bridge the host polled, because the door could not carry a
 * turn's accountability context. door-ctx taught it to (10-mcp §3b), so the
 * session simply points at `{ type: "http", url, headers: { Authorization } }`
 * with a credential scoped to the turn in flight. The door hands each call to
 * `turn.tools.call()` — one guard, one audit row, one mirror, one commit,
 * exactly like `vendo()`. Nothing executes box-side, and this file no longer
 * translates schemas, correlates calls, or knows what a tool IS.
 *
 * What died with the projection: the JSON-Schema→zod translation, the
 * hook/handler correlation queue that made exactly-once hold, the tool listing
 * itself (the door lists LIVE, so a tool `find_tools` equips mid-conversation
 * needs no session reopen), and the `callTool` port in both drivers.
 *
 * It therefore imports NOTHING from the workspace, and — the rule that matters —
 * it never NAMES the Agent SDK. Whoever supplies the machine supplies the SDK:
 * the box door loads it from the machine image, `machine: "local"` loads it from
 * the optional peer that `@vendoai/harnesses` declares. A module that named the
 * package itself was reachable from every composed host's build graph, and a
 * bundler that folds `import(CONST)` then refused to build a host that has no
 * reason to install a ~250MB platform binary. Keep it that way — the emitted
 * `dist/claude-turn.js` is copied verbatim into a machine image.
 *
 * There is no local permission system left (design §3, "claudeCode() specifics";
 * harness-redesign D1). The session runs in `bypassPermissions` because the two
 * things that decide are elsewhere: the BOX is the permission for the box's own
 * hands (copies only, no credentials, domain-filtered egress at the provider's
 * network layer, reality happens at commit), and the DOOR is the permission for
 * host tools — the guard decides there, with the turn's own context, and a refusal
 * arrives as the tool's own in-band error text, which the model narrates and never
 * a throw. {@link DISALLOWED_TOOLS} is the only local tool law that survives.
 *
 * Two limits on how far the box's containment reaches.
 *
 * The egress half is weaker than it sounds: the provider filters by DOMAIN, so
 * an ordinary client is held to the allowlist and a client that omits SNI is
 * not (`docs/verification/box-egress/README.md`). The box is filtered, not
 * jailed.
 *
 * And the containment is about a BOX at all, which this module's other home —
 * `machine: "local"` — does not have: there the same bypass is a real shell on
 * the host's own server, with no network boundary of any kind. The mode is an
 * explicit deployment opt-in and warns the operator on its first turn
 * (`claude-code/local.ts`), but nothing in THIS file makes it safe, and reading
 * the paragraph above as if it did is the mistake to avoid.
 */

/** The MCP server name our projected tools live under (`mcp__vendo__<tool>`). */
export const VENDO_MCP_SERVER = "vendo";

/** The whole of the local tool law, in three groups.
 *
 *  The PROVIDER-SIDE tools act on the vendor's own surfaces over the inference
 *  channel rather than through this host, which puts them outside the box and the
 *  door both — no guard, no audit row, no egress filter. (`Projects`' own
 *  `project_write` uploads a workspace file provider-side and its schema says the
 *  contents "never enter your context", so not even the transcript records what
 *  left; `ClaudeDesign` writes to a design server behind its own login.)
 *
 *  The SCHEDULING family leaves execution BEHIND: a cron job, remote trigger or
 *  wakeup outlives the turn that created it and fires with no turn to be
 *  accountable to, so whatever it then does passes no guard, lands no audit row and
 *  meets no egress filter. `CronDelete`/`CronList` are here for the other direction
 *  too — under `machine: "local"` the schedules on that disk are the OPERATOR's,
 *  and a tenant's turn may neither enumerate nor destroy them.
 *
 *  `disallowedTools` removes them from the model's view entirely, so it never plans
 *  around them. Everything else the SDK ships runs — and `claude-turn.test.ts`
 *  holds a ledger of every tool the SDK's own generated schemas enumerate, so a
 *  name a future SDK adds fails a test instead of being admitted in silence. */
const DISALLOWED_TOOLS = [
  // No user to ask, no egress to spend.
  "WebSearch",
  "WebFetch",
  "AskUserQuestion",
  // Provider-side: the vendor's surfaces, over the inference channel.
  "Projects",
  "Artifact",
  "PushNotification",
  "SendFeedback",
  "ClaudeDesign",
  // Scheduling: execution that outlives the turn that asked for it.
  "RemoteTrigger",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
];

/**
 * Where a beat sits in the arc of making something — a STRUCTURAL MIRROR of
 * core's `BeatPhase` (contract §3.4), CLOSED at six.
 *
 * Restated rather than imported because this file imports nothing (module
 * header). `claude-code/index.ts` yields these events straight into
 * `HarnessEvent`, so the compiler already compares the two unions — but in ONE
 * direction only, and 200 lines away as an inference failure nobody can read.
 * `BEAT_PHASES` there closes the other direction and names the drift; it is in
 * production code rather than a test because nothing in this repo typechecks a
 * test file.
 */
export type BeatPhase =
  | "understanding"
  | "planning"
  | "assembling"
  | "building"
  | "checking"
  | "finishing";

export type ClaudeTurnEvent =
  | { type: "text"; delta: string }
  /**
   * A BEAT — consumer voice, ephemeral, screen only.
   *
   * `phase` and `appId` are ADDITIVE (§3.4): a status carrying nothing but a
   * `label` puts the identical chunk on the wire it always did. `appId` stays
   * unset here — this loop is never told which app it is building, and the
   * contract makes the field optional precisely so a producer without one leaves
   * it off instead of parsing an id out of a file path.
   */
  | { type: "status"; label: string; phase?: BeatPhase; appId?: string }
  | { type: "error"; message: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; model?: string }
  /** Not a `HarnessEvent`: the native session ref the caller puts in `turn.state`. */
  | { type: "session"; sessionId: string }
  ;

export interface ClaudeSessionInput {
  /** `Turn.system` — appended to the SDK's own claude_code preset, never replacing
   *  it: the co-training is the reason this harness exists. */
  systemPrompt?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  /** The native session to continue — only meaningful on a machine whose disk
   *  still holds it (`turn.state`). */
  resume?: string;
  /** The materialized workspace root on this machine. */
  cwd: string;
  /** `CLAUDE_CONFIG_DIR` included: where the SDK keeps its session file is the
   *  machine's choice, made in the environment and never read back here. */
  env: Record<string, string>;
  /**
   * A local PLUGIN root for native skill discovery — the SDK reads
   * `<pluginPath>/skills/<name>/SKILL.md`, which is EXACTLY the layout our
   * `/host` mount already lands (`hostSkillFiles` in core). So the host mount IS
   * the plugin: no copy, no translation, no second skills mechanism. Omitted, no
   * plugin is loaded at all.
   */
  pluginPath?: string;
  /**
   * Exactly which discovered skills to enable, by name.
   *
   * `skills: "all"` enables EVERY skill the engine discovered — which on a host
   * running `machine: "local"` includes the operator's own `~/.claude/skills`
   * (measured 2026-08-02: a probe saw `deep-research`, `dataviz`, `claude-api`…
   * alongside ours). That is the operator's private tooling leaking into a
   * customer's agent, so the enabled set is OURS by name, never "all".
   */
  skillNames?: readonly string[];
  /**
   * A file this session's work just wrote, from the SDK's NATIVE `PostToolUse`
   * hook. This is what replaces mid-turn file-watch polling: the host syncs on
   * WRITE instead of on a timer. `undefined` means a tool that writes without
   * naming a path (`Bash`), which the host answers with one narrow
   * collect-by-shape rather than a whole-tree read.
   */
  onFileWritten?: (path: string | undefined) => void;
  /**
   * The host's own MCP door, and a credential for the turn in flight.
   *
   * This is the ONLY way anything reaches the world. Absent, the session runs
   * with the box's own hands and no host tools at all — which is a real
   * deployment (a host that never opened the door) and never a silent
   * degradation: `claudeCode()` refuses to open a session it cannot give tools
   * to when a door exists but has no reachable URL.
   */
  toolDoor?: { url: string; token: string };
  emit: (event: ClaudeTurnEvent) => void;
  /**
   * The Agent SDK module, supplied by whoever supplied the machine: the box door
   * loads it from the image, `machine: "local"` loads it from the optional peer
   * `@vendoai/harnesses` declares (contract build-list item 1). REQUIRED, so
   * this file never names the package and never lands in a host's build graph
   * for it. Tests pass a double.
   */
  sdk: SdkModule;
}

/**
 * One conversation's live session — held open, chat in / stream out.
 *
 * The whole cc-native change is that this object OUTLIVES a turn. `send()` pushes
 * the user's next message into a session that never stopped, which is what makes
 * turn 2 cost nothing and remember everything.
 */
export interface ClaudeSession {
  /** Push one user message in and settle when THAT message's turn is done. */
  send(prompt: string): Promise<void>;
  /**
   * Hand the user's words to the turn ALREADY in flight — mid-build steering.
   *
   * Same session, same turn, same `send()` still awaiting: the SDK hands the
   * message to the model at its next step boundary, which is why nothing here
   * queues. Answers whether the words landed; `false` when no turn is in flight,
   * because then there would be nobody for the extra `result` to settle and the
   * caller's own next `send()` is the right home for the message.
   */
  steer(prompt: string): boolean;
  /**
   * Stop the turn in flight WITHOUT ending the conversation — the user hit stop,
   * they did not close the tab. A live session makes this distinction real:
   * aborting the whole session would throw away everything it remembers.
   */
  interrupt(): Promise<void>;
  /** Close the input stream and let the SDK's own loop finish. */
  end(): Promise<void>;
}

/** One user message as the SDK's streaming input wants it. */
interface SessionUserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
}

/** The bits of the SDK this file uses. Narrow on purpose: the real message union
 *  has ~40 members and this file branches on four. */
export interface SdkModule {
  query(params: {
    prompt: string | AsyncIterable<SessionUserMessage>;
    options: Record<string, unknown>;
  }): AsyncIterable<Record<string, unknown>> & { interrupt?: () => Promise<unknown> };
}

/** The SDK's `usage` block, in the `HarnessEvent` vocabulary. */
function usageEvent(raw: unknown, model: string | undefined): ClaudeTurnEvent | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const cacheRead = num(usage["cache_read_input_tokens"]);
  const cacheWrite = num(usage["cache_creation_input_tokens"]);
  return {
    type: "usage",
    inputTokens: num(usage["input_tokens"]),
    outputTokens: num(usage["output_tokens"]),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(model === undefined ? {} : { model }),
  };
}

/**
 * A push-driven async iterable — the session's input side.
 *
 * The SDK wants an `AsyncIterable` it can pull from for the life of the
 * conversation; callers arrive one `send()` at a time. Buffering here is what
 * lets a message pushed before the SDK has started pulling still be the first
 * thing it reads.
 */
function messageInbox() {
  const buffered: SessionUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(message: SessionUserMessage) {
      buffered.push(message);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *stream(): AsyncGenerator<SessionUserMessage> {
      for (;;) {
        while (buffered.length > 0) yield buffered.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    },
  };
}

/**
 * The files a `PostToolUse` hook is worth firing for.
 *
 * `Bash` is here on purpose even though it names no path: `echo … > app.vendo` is
 * a real way to write a hot file, and reporting the write without the path still
 * lets the host do ONE narrow collect-by-shape. That is strictly better than the
 * 1.2s timer this replaces — sync on write, not sync on tick.
 */
const WRITING_TOOLS = "Write|Edit|MultiEdit|NotebookEdit|Bash";

/** The same names, as a set — one list decides both the hook matcher above and
 *  the building beat, so the two can never disagree about what a write is. */
const WRITING_TOOL_NAMES = new Set(WRITING_TOOLS.split("|"));

/**
 * The task-list tool: the model writes its plan as todos and flips them as it
 * goes, which is the one place this loop can watch PLANNING happen.
 *
 * Only THAT it was used is read. Its `activeForm` field is documented by the CLI
 * as "the present continuous form shown during execution" and is a beat in all
 * but name — and it is also the model's own untrusted text, free to say
 * "Creating app/src/InvoiceTable.tsx". Admitting it would need a regex gate over
 * model prose, which ruling 14 (`ui/src/consumer-voice.ts`) already tried and
 * reversed: a regex set cannot be the authority for what a person may read. So
 * the beats below are OUR fixed copy, and this loop holds no filename it could
 * leak.
 *
 * A future SDK that RENAMES this tool makes the planning beat fall silent, which
 * is the right failure — silence, never a lie about progress. The rename itself
 * is already loud: `claude-turn.test.ts` fails on any tool name its ledger has
 * not classified.
 */
const PLANNING_TOOL = "TodoWrite";

/**
 * Everything `query()` is told, once, for the life of the session.
 *
 * A sibling function rather than a sibling MODULE: `dist/claude-turn.js` is
 * copied verbatim into the machine image (module header), so this file has no
 * relative imports to give it.
 */
function sessionOptions(
  input: ClaudeSessionInput,
  onPostToolUse: (raw: unknown) => Promise<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    cwd: input.cwd,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
    ...(input.resume === undefined ? {} : { resume: input.resume }),
    // Append, never replace: the co-trained Claude Code harness IS the product
    // decision behind this adapter.
    systemPrompt: { type: "preset", preset: "claude_code", append: input.systemPrompt ?? "" },
    // Nothing local left to ask: the box contains the box's own hands, and the
    // guard decides host tools at the door (module header).
    permissionMode: "bypassPermissions",
    // The SDK documents the pair as required ("Must be set to `true` when using
    // `permissionMode: 'bypassPermissions'`"); today's CLI treats it as advisory
    // (measured 2026-08-03), so this is hygiene against one that enforces it.
    allowDangerouslySkipPermissions: true,
    disallowedTools: DISALLOWED_TOOLS,
    // The host's own door, over native remote MCP. `alwaysLoad` because this
    // surface is deliberately UNCURATED (`toolSurface: { curated: false }`):
    // the door lists everything the ctx projects — THE LAW's §12 withholding
    // and the host's `surfaces.agent` menu still decide that set — so letting
    // the engine defer the listing behind its own tool search would put back
    // exactly the friction the redesign removed. It also makes an unreachable
    // door fail at startup instead of silently presenting a model with no hands.
    ...(input.toolDoor === undefined ? {} : {
      mcpServers: {
        [VENDO_MCP_SERVER]: {
          type: "http",
          url: input.toolDoor.url,
          headers: { Authorization: `Bearer ${input.toolDoor.token}` },
          alwaysLoad: true,
        },
      },
    }),
    // Never read settings or CLAUDE.md off the materialized workspace: those are
    // the USER's files, and a file cannot be allowed to configure the harness.
    // This disables FILESYSTEM settings discovery only — `plugins` below is an
    // explicit programmatic list, so native skills survive tenant isolation.
    settingSources: [],
    // The other half of that rule, for MCP: `settingSources` closes SETTINGS
    // discovery, and the SDK names a project `.mcp.json` as something only this
    // flag ignores. The box's cwd is a disk the model writes itself, and `reopen`
    // relaunches a fresh CLI over it — a server mounted that way would arrive as
    // `mcp__*` tools, outside DISALLOWED_TOOLS, the guard, the audit log and the
    // egress filter. The door above is the only MCP server this box wants.
    strictMcpConfig: true,
    // Without this the SDK hands us whole assistant blocks and the user watches
    // a still screen for the length of a paragraph.
    includePartialMessages: true,
    // The engine announces `session_state_changed` only when this is set, and that
    // event is the only thing that can tell a steered turn its work is over
    // without guessing how many `result` messages to expect (see
    // `steersAwaitingResult`). Ours wins over the machine's env because it is this
    // loop's protocol, not an operator preference — and an engine that does not
    // know the variable simply ignores it.
    env: { ...input.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
    ...(input.pluginPath === undefined ? {} : {
      // `skipMcpDiscovery`: we own the MCP wiring (the in-process projection),
      // so the engine must not read a plugin's own .mcp.json.
      plugins: [{ type: "local", path: input.pluginPath, skipMcpDiscovery: true }],
      // The SDK's single switch for turning discovered skills ON. NAMED, never
      // "all": "all" also enables whatever the machine's own home directory
      // happens to carry. A plugin whose skills are never enabled is a
      // directory nobody reads, so an empty name list still passes [].
      skills: [...(input.skillNames ?? [])],
    }),
    ...(input.onFileWritten === undefined ? {} : {
      hooks: { PostToolUse: [{ matcher: WRITING_TOOLS, hooks: [onPostToolUse] }] },
    }),
  };
}

/**
 * One `assistant` message, read for what the user should see.
 *
 * An `assistant` message is the COMPLETED form of prose that may already
 * have streamed as deltas. Emitting both showed the user every sentence
 * twice (measured live 2026-08-02, once `includePartialMessages` went on).
 * Whichever arrived first wins; the block is still the only source when
 * an SDK build streams nothing, so the fallback stays real.
 *
 * The message is SCANNED either way, never skipped whole: a `tool_use`
 * block rides in the SAME message as the sentence that introduced it, so
 * skipping the duplicate prose also threw away every beat in any turn
 * where the model spoke — which is every real turn.
 */
function readAssistantMessage(
  input: ClaudeSessionInput,
  message: Record<string, unknown>,
  streamed: boolean,
  beat: (phase: BeatPhase, label: string) => void,
): void {
  const content = (message["message"] as { content?: Array<Record<string, unknown>> } | undefined)?.content;
  for (const block of content ?? []) {
    if (block["type"] === "text") {
      if (!streamed && typeof block["text"] === "string" && block["text"] !== "") {
        input.emit({ type: "text", delta: block["text"] });
      }
    } else if (block["type"] === "tool_use" && typeof block["name"] === "string") {
      // The tool's NAME and nothing else. Its inputs are the model's own
      // text and can name a file (see {@link PLANNING_TOOL}).
      if (block["name"] === PLANNING_TOOL) beat("planning", "Working out the steps");
      else if (WRITING_TOOL_NAMES.has(block["name"])) beat("building", "Putting it together");
    }
  }
}

/**
 * Open ONE live session for a whole conversation.
 *
 * `query()` is called exactly once. Its `prompt` is a stream we keep open, so a
 * second user message is a PUSH rather than a cold start: no re-materialize, no
 * resume ref, no re-seed. `send()` settles on its own turn's `result`, which is
 * how the SDK says "this turn is done" while the input stays open.
 */
export function createClaudeSession(input: ClaudeSessionInput): ClaudeSession {
  const sdk = input.sdk;
  const inbox = messageInbox();
  let model: string | undefined = input.model;
  /** Settles the `send()` whose turn is currently in flight. */
  let settleTurn: ((error?: unknown) => void) | undefined;
  /**
   * How many `result` messages a steer may still absorb before one of them is
   * allowed to end the caller's turn — a CAP on the wait, never a prediction.
   *
   * THE HAZARD IT IS FOR. A steer that only pushed would resolve the original
   * `send()` at the first result it saw: the box door marks the message done, the
   * harness's poll loop returns, the turn ends on the wire — and the steer's own
   * output is pushed into a state nobody polls. So a steer buys the turn one more
   * boundary before it may end.
   *
   * WHY IT IS ONLY A CAP. It used to be an exact count, on the belief that every
   * user message the engine answers produces its own `result`. Nothing guarantees
   * that. The engine's own docs say a queued batch is "coalesced into one turn"
   * and that a message it merges "does query" only once — steering's whole
   * premise, that the words reach the model at its next STEP boundary, is a turn
   * that never gains a second result at all. An exact count then swallows the
   * FINAL result and the caller waits out the harness's whole message budget
   * (15 minutes) for work that finished minutes ago. A hang bought with a guess,
   * which is why the count no longer decides on its own: `session_state_changed`
   * does, below.
   */
  let steersAwaitingResult = 0;
  /** A session that died. Every later `send()` fails with it rather than hanging. */
  let fatal: unknown;

  const onPostToolUse = async (raw: unknown): Promise<Record<string, unknown>> => {
    const hook = raw as { tool_input?: { file_path?: unknown } };
    const written = hook.tool_input?.file_path;
    input.onFileWritten?.(typeof written === "string" ? written : undefined);
    // This hook OBSERVES. Permission is the box and the door; a hook that
    // returned a decision here would be a permission system smuggled back in.
    return {};
  };

  /** The open `Query`, once it exists — the only thing that can interrupt a turn. */
  let live: { interrupt?: () => Promise<unknown> } | undefined;

  /**
   * Which stages this turn has already narrated (§3.4: "one beat per real step").
   *
   * A phase is a STAGE, not a tick — the tenth file write is not news — so each
   * fires once and the set clears at the turn boundary, letting turn 2 plan and
   * build again. `understanding` rides the session's own `init`, which happens
   * once per SESSION: turn 2 does not claim to be getting started, because it
   * isn't.
   */
  const narrated = new Set<BeatPhase>();
  const beat = (phase: BeatPhase, label: string): void => {
    if (narrated.has(phase)) return;
    narrated.add(phase);
    input.emit({ type: "status", label, phase });
  };

  /**
   * Release whoever is waiting on the turn in flight. Idempotent, and it clears
   * the steer cap WHOLE: a cap that outlived its turn would be spent against the
   * next caller's boundaries instead.
   */
  const endTurn = (error?: unknown): void => {
    steersAwaitingResult = 0;
    const settle = settleTurn;
    settleTurn = undefined;
    settle?.(error);
  };

  const drain = (async () => {
    const query = sdk.query({ prompt: inbox.stream(), options: sessionOptions(input, onPostToolUse) });
    live = query;
    /** Did the message now being assembled already reach the user as deltas? */
    let streamed = false;
    for await (const message of query) {
      const type = message["type"];
      if (type === "system" && message["subtype"] === "init") {
        const announced = message["session_id"];
        if (typeof announced === "string") {
          input.emit({ type: "session", sessionId: announced });
        }
        const named = message["model"];
        if (typeof named === "string") model = named;
        beat("understanding", "Getting started");
        continue;
      }
      if (type === "system" && message["subtype"] === "session_state_changed") {
        // THE authority on when a steered turn is over, and the reason the cap
        // above can stay a cap. The engine's own schema calls `idle` the
        // "authoritative turn-over signal" — its queue is empty and no turn is
        // running — so nothing further is coming for this message no matter how
        // many results the engine chose to emit for it. An engine that never says
        // so leaves the cap as the only signal, which is exactly the old
        // behaviour: no worse, and better wherever the count guessed high.
        if (message["state"] === "idle") endTurn();
        continue;
      }
      if (type === "assistant") {
        readAssistantMessage(input, message, streamed, beat);
        streamed = false;
        continue;
      }
      if (type === "stream_event") {
        // Real token streaming, now that partial messages are always requested.
        const event = message["event"] as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta"
          && typeof event.delta.text === "string" && event.delta.text !== "") {
          streamed = true;
          input.emit({ type: "text", delta: event.delta.text });
        }
        continue;
      }
      if (type === "result") {
        const usage = usageEvent(message["usage"], model);
        if (usage !== undefined) input.emit(usage);
        if (message["subtype"] !== "success") {
          // Consumer voice: no subtypes, no internals. And no `finishing` beat —
          // a beat that claimed progress in front of an error would be a lie.
          input.emit({ type: "error", message: "I couldn't finish that one." });
        } else if (steersAwaitingResult === 0) {
          // Only the FINAL result finishes. A result a steer is still waiting on is
          // an INTERMEDIATE boundary — the turn continues (that is the whole point
          // of the cap) — so "Finishing up" here would claim the build is done
          // while the correction's rework is still ahead (§3.4, no progress-lie).
          beat("finishing", "Finishing up");
        }
        // Narration resets on EVERY result, steered ones included: the next turn
        // narrates afresh, and a steered correction carries THIS turn on, so it
        // must be free to re-narrate the phases the first pass already showed
        // (the mockup's "Regrouping by client"). Cleared BEFORE the steer skip,
        // or the rework's build/plan beats would stay suppressed and the turn
        // would fall silent during the one moment steering exists to show.
        narrated.clear();
        if (steersAwaitingResult > 0) {
          // Spend one steer's allowance. A boundary that arrives while the turn is
          // still owed steered work is intermediate, and the turn continues.
          steersAwaitingResult -= 1;
          continue;
        }
        // THE turn boundary. The input stream stays open; only this message's
        // caller is released.
        endTurn();
      }
    }
  })().catch((error: unknown) => {
    fatal = error;
    endTurn(error);
  });

  /** One turn at a time: the SDK answers pushed messages in order, so two
   *  overlapping sends would each wait on the other's `result`. */
  let queue: Promise<void> = Promise.resolve();

  const sendOne = async (prompt: string): Promise<void> => {
    if (fatal !== undefined) throw fatal;
    const settled = new Promise<void>((resolve, reject) => {
      settleTurn = (error) => (error === undefined ? resolve() : reject(error));
    });
    inbox.push({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null });
    await settled;
  };

  return {
    send(prompt) {
      const run = () => sendOne(prompt);
      // `.then(run, run)`: a turn that failed must not wedge the conversation.
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    },
    steer(prompt) {
      if (settleTurn === undefined) return false;
      steersAwaitingResult += 1;
      inbox.push({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null });
      return true;
    },
    async interrupt() {
      // An interrupted session stops reading its input, so the boundaries the
      // steers were allowed to absorb may never arrive. Left allowed, the caller's
      // promise would hang to the message budget instead of ending on stop.
      steersAwaitingResult = 0;
      // Only meaningful in streaming-input mode, which is the only mode we use.
      // A session too young to have opened its query has nothing to stop.
      await live?.interrupt?.().catch(() => undefined);
    },
    async end() {
      inbox.close();
      await drain;
    },
  };
}
