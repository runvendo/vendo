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
 * One permission law still lives here (design §3, "claudeCode() specifics"): the
 * box is AUTO-ALLOW for its own file/bash work (the box IS the permission —
 * copies only, no credentials, domain-filtered egress at the provider's network
 * layer, reality happens at commit), so those tools are pre-approved. Our
 * guard's asks are no longer delivered through the SDK's native permission hook,
 * because the guard now decides at the DOOR: a refusal arrives as the tool's own
 * in-band error text, which is still something the model narrates and never a
 * throw.
 *
 * Two limits on how far that law reaches.
 *
 * The egress half is weaker than it sounds: the provider filters by DOMAIN, so
 * an ordinary client is held to the allowlist and a client that omits SNI is
 * not (`docs/verification/box-egress/README.md`). The box is filtered, not
 * jailed.
 *
 * And the law is about a BOX at all, which this module's other home —
 * `machine: "local"` — does not have: there the same auto-allow is a real shell
 * on the host's own server, with no network boundary of any kind. The mode is an
 * explicit deployment opt-in and warns the operator on its first turn
 * (`claude-code/local.ts`), but nothing in THIS file makes it safe, and reading
 * the paragraph above as if it did is the mistake to avoid.
 */

/** The MCP server name our projected tools live under (`mcp__vendo__<tool>`). */
export const VENDO_MCP_SERVER = "vendo";

/** The box's own hands (design §4): a real shell over a workspace COPY. */
export const BOX_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite"] as const;

/** Never available to a headless box turn: no user to ask, no egress to spend.
 *  Redundant with the hook's allow-list ON PURPOSE: `disallowedTools` removes
 *  these from the model's view entirely, so it never plans around them; the
 *  hook denial below is the backstop for an SDK that offers them anyway. */
const DISALLOWED_TOOLS = ["WebSearch", "WebFetch", "AskUserQuestion"];

/** The SDK's subagent door. Allowing the dispatcher grants nothing by itself:
 *  a subagent's inner calls come back through the same permission hook one by
 *  one, each judged on its own name. */
const SUBAGENT_TOOLS = ["Task"];

export type ClaudeTurnEvent =
  | { type: "text"; delta: string }
  | { type: "status"; label: string }
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
  /** Names the box may run without asking. Defaults to {@link BOX_TOOLS}. */
  allowedBoxTools?: readonly string[];
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

/**
 * The box's permission hook — an ALLOW-LIST, and now the whole of it.
 *
 * It used to be where a projected tool actually EXECUTED: `turn.tools.call()` is
 * atomic (guard + execute + audit + mirror), so it could not be split into a
 * check for the hook and a run for the handler, and doing it in the hook was
 * what let a guard denial come back as the SDK's native `{behavior:"deny"}`.
 * All of that moved to the door. What is left is the one law that was always
 * local: the box may use its own hands, and nothing else.
 *
 * "Its own hands" is only a safe grant where there is a BOX. On the
 * `machine: "local"` path these same names are the host server's shell and
 * filesystem — see this module's header.
 *
 * `mcp__vendo__*` is allowed here because the DOOR is the permission for those
 * — the guard decides there, on the host, with the turn's own context. A denial
 * comes back as the tool's in-band error text instead of the native deny
 * behavior; the model narrates either way, and it is the guard's own sentence.
 */
function boxPermission(input: ClaudeSessionInput) {
  const prefix = `mcp__${VENDO_MCP_SERVER}__`;
  // A deny-list here meant every tool nobody had foreseen — say an SDK upgrade
  // shipping a new built-in with egress — was silently allowed; unnamed must
  // mean denied.
  const boxAllowed = new Set<string>([...(input.allowedBoxTools ?? BOX_TOOLS), ...SUBAGENT_TOOLS]);
  return async (name: string, rawArgs: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (name.startsWith(prefix) || boxAllowed.has(name)) {
      return { behavior: "allow", updatedInput: rawArgs };
    }
    return { behavior: "deny", message: `${name} isn't available in this workspace.` };
  };
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
  let sessionId: string | undefined;
  let model: string | undefined = input.model;
  /** Settles the `send()` whose turn is currently in flight. */
  let settleTurn: ((error?: unknown) => void) | undefined;
  /** A session that died. Every later `send()` fails with it rather than hanging. */
  let fatal: unknown;

  const onPostToolUse = async (raw: unknown): Promise<Record<string, unknown>> => {
    const hook = raw as { tool_input?: { file_path?: unknown } };
    const written = hook.tool_input?.file_path;
    input.onFileWritten?.(typeof written === "string" ? written : undefined);
    // This hook OBSERVES. Permission lives in `boxPermission`, and a hook that
    // returned a decision here would be a second, quieter permission system.
    return {};
  };

  /** The open `Query`, once it exists — the only thing that can interrupt a turn. */
  let live: { interrupt?: () => Promise<unknown> } | undefined;

  const drain = (async () => {
    const canUseTool = boxPermission(input);

    const options: Record<string, unknown> = {
      cwd: input.cwd,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
      ...(input.resume === undefined ? {} : { resume: input.resume }),
      // Append, never replace: the co-trained Claude Code harness IS the product
      // decision behind this adapter.
      systemPrompt: { type: "preset", preset: "claude_code", append: input.systemPrompt ?? "" },
      // NOT bypassPermissions: the hook is how our guard's asks reach the model.
      permissionMode: "default",
      canUseTool,
      allowedTools: [...(input.allowedBoxTools ?? BOX_TOOLS)],
      disallowedTools: DISALLOWED_TOOLS,
      // The host's own door, over native remote MCP. `alwaysLoad` because our
      // tools are ALREADY curated (the loadout, `surfaces.agent`, THE LAW's §12
      // withholding) — letting the engine defer them behind its own tool search
      // would be a second curation layer over a set we deliberately shaped, and
      // it makes an unreachable door fail at startup instead of silently
      // presenting a model with no hands.
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
      // Without this the SDK hands us whole assistant blocks and the user watches
      // a still screen for the length of a paragraph.
      includePartialMessages: true,
      env: input.env,
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

    const query = sdk.query({ prompt: inbox.stream(), options });
    live = query;
    /** Did the message now being assembled already reach the user as deltas? */
    let streamed = false;
    for await (const message of query) {
      const type = message["type"];
      if (type === "system" && message["subtype"] === "init") {
        const announced = message["session_id"];
        if (typeof announced === "string") {
          sessionId = announced;
          input.emit({ type: "session", sessionId: announced });
        }
        const named = message["model"];
        if (typeof named === "string") model = named;
        continue;
      }
      if (type === "assistant") {
        // An `assistant` message is the COMPLETED form of prose that may already
        // have streamed as deltas. Emitting both showed the user every sentence
        // twice (measured live 2026-08-02, once `includePartialMessages` went on).
        // Whichever arrived first wins; the block is still the only source when
        // an SDK build streams nothing, so the fallback stays real.
        if (streamed) {
          streamed = false;
          continue;
        }
        const content = (message["message"] as { content?: Array<Record<string, unknown>> } | undefined)?.content;
        for (const block of content ?? []) {
          if (block["type"] === "text" && typeof block["text"] === "string" && block["text"] !== "") {
            input.emit({ type: "text", delta: block["text"] });
          }
        }
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
          // Consumer voice: no subtypes, no internals.
          input.emit({ type: "error", message: "I couldn't finish that one." });
        }
        // THE turn boundary. The input stream stays open; only this message's
        // caller is released.
        const settle = settleTurn;
        settleTurn = undefined;
        settle?.();
      }
    }
  })().catch((error: unknown) => {
    fatal = error;
    const settle = settleTurn;
    settleTurn = undefined;
    settle?.(error);
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
    async interrupt() {
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
