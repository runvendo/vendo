import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
// The box door is plain JS shipped into the machine image; the tests drive the
// real module, with only the SDK session injected.
import { createSessionRoutes } from "../box/turn-routes.mjs";

const TOKEN = "bxt_test";
const roots: string[] = [];

const newRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "vendo-session-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const b64 = (text: string): string => Buffer.from(text).toString("base64");
const auth = { "x-vendo-box-token": TOKEN };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Routes = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * A session double. The real `createClaudeSession` opens ONE query and answers
 * each pushed message; this stands in for it by running `body` per `send()`, so
 * the door's own halves — the poll cursor, the message registry, the credential
 * hand-off — are the only things under test.
 */
const scripted = (body: (input: Any, prompt: string) => Promise<void>) => {
  const opens: Any[] = [];
  const factory = (input: Any) => {
    opens.push(input);
    return {
      async send(prompt: string) { await body(input, prompt); },
      async interrupt() { input.__interrupted = true; },
      async end() { input.__ended = true; },
    };
  };
  return { factory, opens };
};

const routes = (root: string, body?: (input: Any, prompt: string) => Promise<void>): Routes => {
  const session = body === undefined ? undefined : scripted(body);
  const door = createSessionRoutes({
    root,
    token: TOKEN,
    env: {},
    ...(session === undefined ? {} : { openSession: session.factory }),
  }) as Routes;
  door.__opens = session?.opens ?? [];
  return door;
};

/** Post one message and return its id. */
const send = async (door: Routes, prompt: string, extra: Record<string, unknown> = {}) => {
  const started = await door.handle("POST", "/session/message", auth, { prompt, ...extra });
  return started;
};

describe("the box session door refuses anything without the machine token", () => {
  test("every /session route is closed to a caller with no token", async () => {
    const door = routes(newRoot());
    const answer = await door.handle("POST", "/session/collect", {}, {});
    expect(answer.status).toBe(401);
  });

  test("a machine with no token yet is claimed by the first hello, and closed after", async () => {
    const door = createSessionRoutes({ root: newRoot(), token: "", env: {} }) as Routes;
    expect((await door.handle("POST", "/session/collect", auth, {})).status).toBe(401);
    expect((await door.handle("POST", "/session/hello", {}, { token: TOKEN })).status).toBe(200);
    expect((await door.handle("POST", "/session/collect", auth, {})).status).toBe(200);
    // Trust on FIRST use: a second, unauthenticated hello cannot steal the box.
    expect((await door.handle("POST", "/session/hello", {}, { token: "attacker" })).status).toBe(401);
    expect((await door.handle("POST", "/session/collect", auth, {})).status).toBe(200);
  });

  test("there is no token ROTATION any more — a claimed box keeps the one token it was given", async () => {
    // The rotation protocol existed for ONE reason: a snapshot restored a
    // supervisor's memory, so a woken box still demanded the token it slept with
    // while the host minted a fresh one per acquire. A conversation box is never
    // snapshotted and never woken — it is destroyed — so rotation has no case
    // left to serve, and the simpler rule is the safer one.
    const door = createSessionRoutes({ root: newRoot(), token: TOKEN, env: {} }) as Routes;
    // The holder re-presenting its own token is the liveness probe, and it is
    // idempotent rather than a rotation.
    expect((await door.handle("POST", "/session/hello", auth, { token: TOKEN })).status).toBe(200);
    expect((await door.handle("POST", "/session/collect", auth, {})).status).toBe(200);
    // Nobody else may claim or change it.
    expect((await door.handle("POST", "/session/hello", { "x-vendo-box-token": "fresh" }, { token: "fresh" })).status)
      .toBe(401);
    expect((await door.handle("POST", "/session/collect", { "x-vendo-box-token": "fresh" }, {})).status).toBe(401);
  });

  test("hello carries the conversation's credential to the SDK, and nothing else does", async () => {
    let saw: Record<string, string> | undefined;
    const session = scripted(async () => undefined);
    const door = createSessionRoutes({
      root: newRoot(), token: "", env: {},
      openSession: (input: Any) => {
        saw = input.env;
        return session.factory(input);
      },
    }) as Routes;
    await door.handle("POST", "/session/hello", {}, { token: TOKEN, env: { ANTHROPIC_API_KEY: "k", NOPE: 7 } });
    const { body } = await send(door, "go");
    await door.messagePromise(body.messageId);
    expect(saw).toEqual({ ANTHROPIC_API_KEY: "k" });
  });
});

describe("materialize + collect", () => {
  test("files land under the root in the frozen layout, and read back by workspace path", async () => {
    const root = newRoot();
    const door = routes(root);
    await door.handle("POST", "/session/workspace", auth, {
      reset: true,
      files: [
        { path: "/user/apps/app_1/app.vendo", base64: b64("<App/>") },
        { path: "/host/skills/refund/SKILL.md", base64: b64("# refund"), readOnly: true },
      ],
    });
    expect(readFileSync(path.join(root, "user/apps/app_1/app.vendo"), "utf8")).toBe("<App/>");

    const collected = await door.handle("POST", "/session/collect", auth, {});
    // Only the writable mount comes back: /host is reference, never a diff.
    expect(collected.body.files.map((f: { path: string }) => f.path)).toEqual([
      "/user/apps/app_1/app.vendo",
    ]);
  });

  test("the /host mount lands where the SDK looks for a local plugin's skills", async () => {
    // The plugin root the harness passes is `<root>/host`, and the SDK reads
    // `<pluginPath>/skills/<name>/SKILL.md`. `hostSkillFiles` already writes
    // exactly that path, so the mount IS the plugin — no copy, no translation.
    const root = newRoot();
    const door = routes(root);
    await door.handle("POST", "/session/workspace", auth, {
      reset: true,
      files: [{ path: "/host/skills/refund/SKILL.md", base64: b64("# refund"), readOnly: true }],
    });
    expect(readFileSync(path.join(root, "host", "skills/refund/SKILL.md"), "utf8")).toBe("# refund");
  });

  test("a narrowed collect answers only the asked paths, and skips ones not written yet", async () => {
    const root = newRoot();
    const door = routes(root);
    mkdirSync(path.join(root, "user/apps/app_1"), { recursive: true });
    writeFileSync(path.join(root, "user/apps/app_1/plan.vendo"), "plan");
    const answer = await door.handle("POST", "/session/collect", auth, {
      paths: ["/user/apps/app_1/plan.vendo", "/user/apps/app_1/app.vendo"],
    });
    expect(answer.body.files).toEqual([
      { path: "/user/apps/app_1/plan.vendo", base64: b64("plan") },
    ]);
  });

  test("D5 · a `*` segment asks by SHAPE, which is how a file invented mid-turn is collectable", async () => {
    const root = newRoot();
    const door = routes(root);
    // The appId the host could NOT have named when the conversation started.
    mkdirSync(path.join(root, "user/apps/app_invented"), { recursive: true });
    writeFileSync(path.join(root, "user/apps/app_invented/plan.vendo"), "plan");
    // Deliberate near-misses: `*` is ONE segment, and the hot names are exact.
    mkdirSync(path.join(root, "user/apps/app_invented/nested"), { recursive: true });
    writeFileSync(path.join(root, "user/apps/app_invented/nested/plan.vendo"), "deeper");
    writeFileSync(path.join(root, "user/apps/app_invented/notes.md"), "notes");
    const answer = await door.handle("POST", "/session/collect", auth, {
      paths: ["/user/apps/*/plan.vendo"],
    });
    expect(answer.body.files).toEqual([
      { path: "/user/apps/app_invented/plan.vendo", base64: b64("plan") },
    ]);
  });

  test("D5 · a walking collect never answers about /host, `*` included", async () => {
    const root = newRoot();
    const door = routes(root);
    mkdirSync(path.join(root, "host/skills/refund"), { recursive: true });
    writeFileSync(path.join(root, "host/skills/refund/SKILL.md"), "# refund");
    const answer = await door.handle("POST", "/session/collect", auth, { paths: ["/host/*/*"] });
    expect(answer.body.files).toEqual([]);
  });

  test("§9.7 · a whole-tree collect carries an /orgs mount home beside /user", async () => {
    // The mount a team's shared app lives in. A walk pinned to `/user/` left the
    // edit on the box's disk and reported nothing, so the host's diff saw an
    // unchanged file and the agent's "done" was a lie.
    const root = newRoot();
    const door = routes(root);
    await door.handle("POST", "/session/workspace", auth, {
      reset: true,
      files: [
        { path: "/orgs/acme/apps/app_1/app.vendo", base64: b64("team app") },
        { path: "/orgs/acme/files/plan.md", base64: b64("team plan") },
        { path: "/user/memory/mine.md", base64: b64("mine") },
        { path: "/host/skills/refund/SKILL.md", base64: b64("# refund"), readOnly: true },
      ],
    });
    const answer = await door.handle("POST", "/session/collect", auth, {});
    expect(answer.body.files.map((file: { path: string }) => file.path).sort()).toEqual([
      "/orgs/acme/apps/app_1/app.vendo",
      "/orgs/acme/files/plan.md",
      "/user/memory/mine.md",
    ]);
  });

  test("§9.7 · a `*` collect finds a TEAM app's hot path — the skeleton paints either way", async () => {
    const root = newRoot();
    const door = routes(root);
    mkdirSync(path.join(root, "orgs/acme/apps/app_invented"), { recursive: true });
    writeFileSync(path.join(root, "orgs/acme/apps/app_invented/plan.vendo"), "team plan");
    const answer = await door.handle("POST", "/session/collect", auth, {
      paths: ["/orgs/*/apps/*/plan.vendo"],
    });
    expect(answer.body.files).toEqual([
      { path: "/orgs/acme/apps/app_invented/plan.vendo", base64: b64("team plan") },
    ]);
  });

  test("a path in NO mount is not carried home, however it got onto the disk", async () => {
    const root = newRoot();
    const door = routes(root);
    mkdirSync(path.join(root, "etc"), { recursive: true });
    writeFileSync(path.join(root, "etc/passwd"), "root");
    // `/orgs` with no org segment is not a mount either — the mount is the org.
    mkdirSync(path.join(root, "orgs"), { recursive: true });
    writeFileSync(path.join(root, "orgs/stray.md"), "stray");
    const answer = await door.handle("POST", "/session/collect", auth, {});
    expect(answer.body.files).toEqual([]);
  });

  test("the SDK's own session store is machine state, never the user's files", async () => {
    const root = newRoot();
    const door = routes(root);
    mkdirSync(path.join(root, ".claude/projects"), { recursive: true });
    writeFileSync(path.join(root, ".claude/projects/sess.jsonl"), "{}");
    const answer = await door.handle("POST", "/session/collect", auth, {});
    expect(answer.body.files).toEqual([]);
  });
});

describe("one live session, many messages", () => {
  test("a second message reuses the SAME session — it is never reopened", async () => {
    const root = newRoot();
    const prompts: string[] = [];
    const door = routes(root, async (_input, prompt) => { prompts.push(prompt); });

    const first = await send(door, "what do I owe?");
    await door.messagePromise(first.body.messageId);
    const second = await send(door, "and the oldest?");
    await door.messagePromise(second.body.messageId);

    expect(prompts).toEqual(["what do I owe?", "and the oldest?"]);
    // ONE open: that is the whole cc-native change.
    expect(door.__opens).toHaveLength(1);
  });

  test("a changed tool set NO LONGER reopens the session — the door lists live", async () => {
    const root = newRoot();
    const door = routes(root, async (input) => {
      input.emit({ type: "session", sessionId: "sess_box" });
    });

    await door.messagePromise((await send(door, "one")).body.messageId);
    // `find_tools` equipping something new used to force a reopen, because an
    // in-process MCP server's tool set is fixed at session open. The host's door
    // answers `tools/list` fresh on every ask, so there is nothing to rebuild.
    await door.messagePromise((await send(door, "two")).body.messageId);

    expect(door.__opens).toHaveLength(1);
    expect(door.__opens[0].__ended).toBeUndefined();
  });

  test("a TRUNCATION still reopens, and the fresh session resumes nothing", async () => {
    const root = newRoot();
    const door = routes(root, async (input) => {
      input.emit({ type: "session", sessionId: "sess_box" });
    });
    await door.messagePromise((await send(door, "one")).body.messageId);
    await door.messagePromise((await send(door, "two", { reopen: true })).body.messageId);

    expect(door.__opens).toHaveLength(2);
    // §1.3: the session remembered an answer the user threw away, so it must NOT
    // come back with its memory — the host's prompt carries the re-seed.
    expect(door.__opens[1].resume).toBeUndefined();
    expect(door.__opens[0].__ended).toBe(true);
  });

  test("the native PostToolUse hook comes home as a `wrote` event, which is what replaced polling", async () => {
    const root = newRoot();
    const door = routes(root, async (input) => {
      input.onFileWritten("/workspace/user/apps/app_1/app.vendo");
      input.onFileWritten(undefined);
    });
    const { body } = await send(door, "build it");
    await door.messagePromise(body.messageId);
    const polled = await door.handle("POST", `/session/${body.messageId}/poll`, auth, { cursor: 0, waitMs: 100 });
    expect(polled.body.events).toEqual([
      { type: "wrote", path: "/workspace/user/apps/app_1/app.vendo" },
      // A `Bash` write names no path; the host answers it with a collect-by-shape.
      { type: "wrote" },
    ]);
  });

  test("interrupt stops the turn and leaves the session alive", async () => {
    const root = newRoot();
    const door = routes(root, async () => undefined);
    const { body } = await send(door, "go");
    await door.messagePromise(body.messageId);
    expect((await door.handle("POST", `/session/${body.messageId}/interrupt`, auth, {})).status).toBe(200);
    expect(door.__opens[0].__interrupted).toBe(true);
    // The session was never ended — only the turn was cut short.
    expect(door.__opens[0].__ended).toBeUndefined();
  });
});

describe("the host's MCP door, forwarded as DATA", () => {
  test("the credential and the door URL reach the session verbatim, and the box asserts nothing about them", async () => {
    const root = newRoot();
    const door = routes(root, async () => undefined);
    const toolDoor = { url: "https://app.example.com/api/vendo/mcp", token: "vtk_abc123" };

    const { body } = await send(door, "what do I owe?", { toolDoor });
    await door.messagePromise(body.messageId);

    // Handed straight to `createClaudeSession`. The box cannot mint one, cannot
    // inspect one, and has no path to the host except this URL — which is the
    // whole of what replaced the inverted bridge.
    expect(door.__opens[0].toolDoor).toEqual(toolDoor);
  });

  test("a message with NO door opens a session with none — a host that never opened one is a real deployment", async () => {
    const root = newRoot();
    const door = routes(root, async () => undefined);
    const { body } = await send(door, "hello");
    await door.messagePromise(body.messageId);
    expect(door.__opens[0].toolDoor).toBeUndefined();
  });

  test("there is no /answer route left to post a tool result to", async () => {
    const root = newRoot();
    const door = routes(root, async () => undefined);
    const { body } = await send(door, "go");
    await door.messagePromise(body.messageId);
    const answered = await door.handle("POST", `/session/${body.messageId}/answer`, auth, { id: "ask_1" });
    expect(answered.status).toBe(404);
  });

  test("one message at a time per box", async () => {
    const root = newRoot();
    let release: (() => void) | undefined;
    const door = routes(root, async () => {
      await new Promise<void>((resolve) => { release = resolve; });
    });
    const first = await send(door, "one");
    const second = await door.handle("POST", "/session/message", auth, { prompt: "two" });
    expect(second.status).toBe(409);
    release?.();
    await door.messagePromise(first.body.messageId);
  });
});
