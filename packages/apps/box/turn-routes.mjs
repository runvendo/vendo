/**
 * The box's `claudeCode()` SESSION door.
 *
 * The existing control port serves the layer-3 app builder (`/agent/*`). This
 * module adds the CONVERSATIONAL door beside it: materialize a workspace copy
 * ONCE, hold ONE Claude Agent SDK session open for the whole conversation, and
 * push each user message into it. Chat in, stream out — exactly like a terminal.
 *
 * **The tool bridge is gone.** It used to be INVERTED: `SandboxMachine.request()`
 * is the only data path INTO a box, so the host drove — post a message, poll;
 * when the model reached a projected tool the box PARKED the ask and handed it
 * out on the next poll; the host ran `turn.tools.call()` and posted the answer
 * back. cc-native measured whether our MCP door could replace that and it could
 * not; door-ctx made it (10-mcp §3b), so the session now reaches the host's
 * tools directly over remote MCP with a turn-scoped credential the host mints.
 *
 * What that deleted here: `callTool`, the per-message `asks` map, the
 * hand-out-once cursor bookkeeping, the `/session/{id}/answer` route, and the
 * tool FINGERPRINT that reopened a session whenever the equipped set changed —
 * the door lists live, so there is nothing to go stale.
 *
 * What it costs: the box now holds an OUTBOUND credential and needs egress to
 * the host's origin, where before it held nothing but a workspace copy, the
 * inference key and the inbound machine token. The credential is strictly
 * weaker than the bridge it replaces — the bridge could ask the host to run any
 * tool the turn could run, and so can this — but it is a real posture change
 * and it is recorded in the lane's close note.
 *
 * The poll loop STAYS: it is how the model's text, usage and `wrote` events
 * leave the box, and nothing about MCP changes that direction of travel.
 *
 * Everything interesting about the SDK loop lives in `claude-turn.mjs`, which is
 * the SAME module `machine: "local"` runs on the host — one implementation, two
 * homes.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const RUNNER = "/opt/vendo-box/claude-turn.mjs";
const MAX_POLL_WAIT_MS = 25_000;
/** Finished messages stay pollable for a little while (a host retrying its last
 *  poll), then go. A session box lives for many messages, and every message's
 *  event buffer kept forever is a slow leak in a long-lived box. */
const MESSAGES_RETAINED = 4;
/**
 * Too big for the wire — the proxy's body limit is what this protects. Under the
 * DEFAULT files store (5 MiB cap) no checked-out file reaches this size; a BYO
 * files adapter has no cap, so the host's sync-back seam exempts oversized
 * checked-out files from absent-means-deleted (`materialize.ts`,
 * `WALK_SKIP_BYTES` — the same 8 MiB) instead of reading this skip as an erasure.
 */
const WALK_SKIP_BYTES = 8 * 1024 * 1024;

/** Workspace path → disk path under the root. The frozen layout (§3.1) is kept
 *  verbatim one level down, so `/user/apps/a/app.vendo` reads the same on both
 *  sides of the wire. */
const toDisk = (root, workspacePath) => path.join(root, workspacePath.replace(/^\/+/, ""));
const toWorkspace = (root, diskPath) => `/${path.relative(root, diskPath).split(path.sep).join("/")}`;

/**
 * Does this workspace path match a wanted entry that names a `*` segment?
 *
 * `*` stands for exactly ONE segment, which is all the hot set needs
 * (`/user/apps/&#42;/plan.vendo`) and the only shape a caller may ask for. Segment
 * comparison rather than a built regex: a path is user-controlled text, and
 * there is no escaping to get wrong.
 */
const matchesPattern = (pattern, workspacePath) => {
  const wanted = pattern.split("/");
  const actual = workspacePath.split("/");
  if (wanted.length !== actual.length) return false;
  return wanted.every((segment, at) => segment === "*" || segment === actual[at]);
};

/**
 * Which mounts a walk of this disk carries home: the caller's own `/user`, and
 * one `/orgs/<orgId>` per membership the host asserted for the turn (§3.1/§9.7).
 * `/host` never does — it is a per-turn projection of the deployment's own
 * files, not the user's.
 *
 * A SHAPE, deliberately, and never a permission: the box holds no store and can
 * ask nobody anything (design §8, "the box is born filtered"). WHETHER a carried
 * path may land is decided host-side, per file, against live rows — the sync-back
 * seam's `canCommit` in `packages/harnesses/src/materialize.ts`, whose
 * `inWritableMount` is this same rule. Keeping this at `/user/` is what made a
 * team file's edit vanish between the box and the store with no error anywhere.
 */
const carriedBack = (workspacePath) => /^\/(?:user|orgs\/[^/]+)\//.test(workspacePath);

const walk = (directory, out) => {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    // The SDK's own session store lives beside the workspace and is machine
    // state, never the user's files.
    if (entry.name === ".claude") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
};

/**
 * @param {object} options
 * @param {string} [options.root]     workspace root (default /workspace)
 * @param {string} [options.token]    the machine token the host must present
 * @param {Function} [options.openSession] injectable session factory (tests)
 * @param {NodeJS.ProcessEnv} [options.env] env handed to the SDK
 */
export const createSessionRoutes = (options = {}) => {
  const root = options.root ?? process.env.VENDO_WORKSPACE_ROOT ?? "/workspace";
  let token = options.token ?? process.env.VENDO_BOX_TOKEN ?? "";
  // What the SDK subprocess gets. Seeded from the machine's own env and
  // REPLACED by /session/hello: the provider does not hand create-time envs to
  // the template's start command (measured 2026-08-01 — the in-box SDK answered
  // "Not logged in"), so the credential arrives with the first message.
  let sdkEnv = { ...(options.env ?? process.env) };

  /** The live session, the id to resume on reopen, and the brief it was OPENED
   *  with — the SDK fixes `systemPrompt` at open, so this is the only record of
   *  what the session is actually thinking with. */
  let session;
  let sessionId;
  let brief;
  /** Every message's buffers, by id. The in-flight one is `current`. */
  const messages = new Map();
  let current;

  const loadFactory = async () => options.openSession ?? (await import(RUNNER)).createClaudeSession;
  /**
   * The SDK, from the machine image (`build-template.mjs` npm-installs it into
   * /opt/vendo-box at BUILD time). It is loaded HERE and not by the runner
   * because the runner's other home is a HOST's server, where naming this
   * package would drag a ~250MB platform binary into the host's build graph.
   * `agent-sdk.mjs` reaches for it exactly the same way.
   */
  const loadSdk = async () => await import("@anthropic-ai/claude-agent-sdk");

  const wake = (state) => {
    for (const resolve of state.waiters.splice(0)) resolve();
  };

  /** Events belong to whichever message is in flight. Between messages nothing
   *  is active, and anything arriving then is dropped rather than attributed to
   *  the next message. */
  const emit = (event) => {
    if (current === undefined) return;
    if (event?.type === "session" && typeof event.sessionId === "string") sessionId = event.sessionId;
    current.events.push(event);
    wake(current);
  };

  /** The host asked for a mid-turn hot sync; it polls for this and syncs. */
  const onFileWritten = (written) => {
    if (current === undefined) return;
    current.events.push({ type: "wrote", ...(typeof written === "string" ? { path: written } : {}) });
    wake(current);
  };

  const openSession = async (payload) => {
    const createClaudeSession = await loadFactory();
    // An injected factory is a test double and brings its own SDK double.
    const sdk = options.openSession === undefined ? await loadSdk() : undefined;
    session = createClaudeSession({
      ...(sdk === undefined ? {} : { sdk }),
      systemPrompt: payload.systemPrompt,
      model: payload.model,
      effort: payload.effort,
      maxTurns: payload.maxTurns,
      // Reopening mid-conversation resumes the session we already have, so a
      // changed tool listing costs a restart and never a memory.
      ...(sessionId === undefined ? {} : { resume: sessionId }),
      ...(payload.pluginPath === undefined ? {} : { pluginPath: payload.pluginPath }),
      ...(payload.skillNames === undefined ? {} : { skillNames: payload.skillNames }),
      // The host's door and this conversation's credential. Data like every
      // other field: the box asserts nothing about it and cannot mint one.
      ...(payload.toolDoor === undefined ? {} : { toolDoor: payload.toolDoor }),
      cwd: root,
      env: { ...sdkEnv },
      emit,
      onFileWritten,
    });
    brief = payload.systemPrompt;
  };

  const startMessage = async (payload) => {
    const messageId = `msg_${randomUUID()}`;
    const state = { events: [], waiters: [], done: false };
    messages.set(messageId, state);
    for (const stale of [...messages.keys()].slice(0, -MESSAGES_RETAINED)) messages.delete(stale);
    current = state;

    // Two reasons to drop a live session before answering.
    //
    // A TRUNCATION (§1.3): the host says this session remembers an answer the
    // user threw away, so it must NOT come back with its memory — the fresh one
    // resumes nothing and the host's prompt carries the re-seed.
    //
    // A CHANGED BRIEF: the SDK fixes `systemPrompt` when the session opens, so
    // a warm session keeps thinking with whatever it opened with. The host's
    // [Situation] is composed per turn and is "current turn only", which is
    // simply false unless the session reopens with it. This one KEEPS the
    // memory — `sessionId` still resumes.
    //
    // Neither used to fire on a CHANGED TOOL LISTING, because an in-process MCP
    // server's tool set is fixed when the session opens. The door lists live, so
    // a tool `find_tools` equips mid-conversation costs nothing.
    try {
      if (session !== undefined && (payload.reopen === true || payload.systemPrompt !== brief)) {
        const closing = session;
        session = undefined;
        if (payload.reopen === true) sessionId = undefined;
        await closing.end().catch(() => undefined);
      }
      if (session === undefined) await openSession(payload);
    } catch (error) {
      // The slot is claimed ABOVE, because `emit` attributes events to whatever
      // is in flight and the session's own id arrives during open. So an open
      // that throws — a box image whose SDK import fails — has to hand the slot
      // back here, or every later message answers 409 instead of this failure.
      messages.delete(messageId);
      if (current === state) current = undefined;
      throw error;
    }

    state.promise = (async () => {
      try {
        await session.send(payload.prompt);
      } catch (error) {
        // The host renders one plain sentence; the detail stays in the box's log.
        console.error("[vendo-box] message failed", error);
        state.events.push({ type: "error", message: "Something went wrong while I was working on that." });
      } finally {
        state.done = true;
        if (current === state) current = undefined;
        wake(state);
      }
    })();
    return messageId;
  };

  /** Hold the poll open until there is something to say, or the wait expires. */
  const poll = async (state, cursor, waitMs) => {
    const deadline = Date.now() + Math.min(Math.max(waitMs ?? 0, 0), MAX_POLL_WAIT_MS);
    for (;;) {
      const fresh = state.events.slice(cursor);
      if (fresh.length > 0 || state.done) {
        return { events: fresh, cursor: cursor + fresh.length, done: state.done };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { events: [], cursor, done: false };
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, remaining);
        state.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  };

  return {
    /** True for anything this module owns, so the supervisor can delegate. */
    owns: (pathname) => pathname.startsWith("/session"),

    /**
     * @returns {Promise<{status:number, body:object}>}
     */
    async handle(method, pathname, headers, payload) {
      if (method !== "POST") return { status: 405, body: { error: "POST only" } };
      const presented = headers["x-vendo-box-token"];
      if (pathname === "/session/hello") {
        // Trust on FIRST use while the box is unclaimed; after that only the
        // holder of the token may speak. There is no ROTATION any more: a box
        // lives for one conversation and is destroyed rather than snapshotted,
        // so there is no woken supervisor holding a stale token to reconcile.
        if (token !== "" && presented !== token) {
          return { status: 401, body: { error: "bad or missing box token" } };
        }
        if (typeof payload?.token !== "string" || payload.token === "") {
          return { status: 400, body: { error: "token must be a non-empty string" } };
        }
        token = payload.token;
        // The credential handoff (design §9): a workspace copy, the inference
        // key, and this token — nothing else ever enters the machine.
        if (typeof payload.env === "object" && payload.env !== null) {
          const next = {};
          for (const [name, value] of Object.entries(payload.env)) {
            if (typeof value === "string") next[name] = value;
          }
          sdkEnv = { ...sdkEnv, ...next };
        }
        return { status: 200, body: { ok: true } };
      }

      // Every other route needs the CURRENT token, always.
      if (token === "" || presented !== token) {
        return { status: 401, body: { error: "bad or missing box token" } };
      }

      if (pathname === "/session/workspace") {
        if (payload?.reset === true) {
          // Empty the root's CONTENTS, never the root itself: the sandbox runs
          // as a non-root user and cannot recreate a directory directly under
          // `/` (measured 2026-08-01 — every materialize answered 500).
          mkdirSync(root, { recursive: true });
          for (const entry of readdirSync(root)) {
            rmSync(path.join(root, entry), { recursive: true, force: true });
          }
        }
        for (const file of Array.isArray(payload?.files) ? payload.files : []) {
          if (typeof file?.path !== "string" || typeof file?.base64 !== "string") continue;
          const target = toDisk(root, file.path);
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, Buffer.from(file.base64, "base64"));
          // `/host` mounts read-only (§3.5). Advisory inside the box — the
          // sync-back seam on the host is what actually refuses the write.
          if (file.readOnly === true) chmodSync(target, 0o444);
        }
        return { status: 200, body: { ok: true } };
      }

      if (pathname === "/session/collect") {
        const wanted = Array.isArray(payload?.paths) ? payload.paths : undefined;
        const files = [];
        if (wanted !== undefined) {
          // A wanted entry naming a `*` segment is how a file that did NOT exist
          // when the conversation started reaches the mid-turn sync: the host
          // cannot pre-name `/user/apps/<a brand-new id>/plan.vendo`, so it asks
          // by shape. Filtered HERE, so the wire carries the hot files and not
          // the tree they were found in.
          const patterns = wanted.filter((entry) => typeof entry === "string" && entry.includes("*"));
          const literals = wanted.filter((entry) => typeof entry === "string" && !entry.includes("*"));
          const matched = patterns.length === 0
            ? []
            : walk(root, [])
              .map((diskPath) => toWorkspace(root, diskPath))
              // Same rule as the whole-tree branch below: a route that WALKS
              // answers about the mounts a machine may write, never `/host`.
              .filter((workspacePath) => carriedBack(workspacePath)
                && patterns.some((pattern) => matchesPattern(pattern, workspacePath)));
          for (const workspacePath of [...new Set([...literals, ...matched])]) {
            try {
              files.push({
                path: workspacePath,
                base64: readFileSync(toDisk(root, workspacePath)).toString("base64"),
              });
            } catch {
              // Not written yet — absent is not a deletion on the hot path.
            }
          }
        } else {
          for (const diskPath of walk(root, [])) {
            const workspacePath = toWorkspace(root, diskPath);
            if (!carriedBack(workspacePath)) continue;
            try {
              if (statSync(diskPath).size > WALK_SKIP_BYTES) continue;
              files.push({ path: workspacePath, base64: readFileSync(diskPath).toString("base64") });
            } catch {
              // A file that vanished mid-walk simply is not in the diff.
            }
          }
        }
        return { status: 200, body: { files } };
      }

      if (pathname === "/session/message") {
        if (current !== undefined) {
          return { status: 409, body: { error: "a message is already running" } };
        }
        if (typeof payload?.prompt !== "string" || payload.prompt.trim() === "") {
          return { status: 400, body: { error: "prompt must be a non-empty string" } };
        }
        return { status: 202, body: { messageId: await startMessage(payload) } };
      }

      const match = /^\/session\/([^/]+)\/(poll|interrupt|steer)$/.exec(pathname);
      if (match === null) return { status: 404, body: { error: `unknown route: ${pathname}` } };
      const state = messages.get(match[1]);
      if (state === undefined) return { status: 404, body: { error: `unknown message: ${match[1]}` } };

      if (match[2] === "poll") {
        const cursor = Number.isInteger(payload?.cursor) ? payload.cursor : 0;
        return { status: 200, body: await poll(state, cursor, payload?.waitMs) };
      }
      if (match[2] === "steer") {
        // The user typed while this message was being answered. Straight into
        // the live session, which hands it to the model at its next step — the
        // box queues nothing, because the SDK's own input stream already does.
        if (typeof payload?.prompt !== "string" || payload.prompt.trim() === "") {
          return { status: 400, body: { error: "prompt must be a non-empty string" } };
        }
        // Only the message IN FLIGHT can take one: a finished message has no turn
        // to fold the words into, and the host's own queue is the fallback. Said
        // as an answer rather than an error — "it did not land" is a fact the
        // host acts on, not a failure.
        const landed = state === current && session?.steer(payload.prompt) === true;
        return { status: 200, body: { landed } };
      }
      // The user hit stop. The SESSION survives — only this turn is cut short,
      // which is the whole reason a live session interrupts instead of aborting.
      await session?.interrupt().catch(() => undefined);
      return { status: 200, body: { ok: true } };
    },

    /** Tests: await one message's completion. */
    messagePromise: (messageId) => messages.get(messageId)?.promise,
  };
};
