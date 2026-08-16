/**
 * THE OUTSIDE-LOCKOUT PIN — an INTERNAL-only door, and the proof that nothing
 * an outsider could use is there.
 *
 * `harness: claudeCode()` reaches the host's tools over the host's own MCP door
 * (10-mcp §3b), so a composition that names such a harness gets a door whether
 * or not it asked for one. `mcp: true` must keep its single meaning — "my users
 * may connect third-party agents to my product" — so the door composition
 * grows a second, narrower shape: the turn-credential half ALONE.
 *
 * This file is `mcp-door-outside-agent.e2e.test.ts` INVERTED. That file measures
 * what a real external MCP client sees at a full door; this one measures that
 * the same client finds nothing at all — no discovery, no authorization server,
 * no registration, no consent, no session, no listing, and a 401 that names no
 * way in. The first test is the control: the door IS mounted and a live turn
 * goes straight through it, so every absence below is a lockout and not an
 * unmounted route.
 *
 * Written and run RED first against a FULL door (the composition below with
 * `mcp: true`), where every lockout assertion fails.
 */
import type { LanguageModel } from "ai";
import { defineHarness, harnessAdapters } from "@vendoai/harnesses";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";
import {
  MOUNT,
  READ_TOOL,
  SUBJECT,
  bearer,
  hostTools,
  openDoor,
  principal,
  rowsAddedBy,
  runCleanups,
  runHarnessTurn,
  shapeOf,
  tempStore,
  type DoorSession,
} from "../src/mcp-door.test-util.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  await runCleanups();
});

const ORIGIN = "https://host.test";

const rpcBody = (method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });

const INITIALIZE = rpcBody("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "outside", version: "1.0.0" },
});

const mcpRequest = (bearerToken?: string, body: string = INITIALIZE): Request =>
  new Request(MOUNT, {
    method: "POST",
    headers: {
      ...(bearerToken === undefined ? {} : { authorization: `Bearer ${bearerToken}` }),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    body,
  });

/**
 * A composition that names a harness whose thinker reaches its tools over the
 * door — and asks for NOTHING else. No `mcp`, no `oauth`: the host never said
 * their users may connect outside agents, and never handed over a way to sign
 * one in.
 */
async function internalHost(
  script: (door: DoorSession) => Promise<void> = async () => undefined,
): Promise<{ vendo: Vendo; store: Awaited<ReturnType<typeof tempStore>> }> {
  const store = await tempStore();
  let composed: Vendo;
  const harness = defineHarness({
    name: "internal-door-probe",
    requires: { toolDoor: true },
    async *run(turn) {
      const port = harnessAdapters(harness).toolDoor;
      if (port === undefined) throw new Error("composition did not provide a tool door");
      const token = port.mint(turn.threadId as string);
      if (token === undefined) throw new Error("no credential could be minted inside a live turn");
      await script(await openDoor(composed, token));
      yield { type: "text", delta: "done" };
    },
  });
  composed = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store,
    guard: { policy: "cautious" },
    harness: harness as never,
  } as Parameters<typeof createVendo>[0]);
  composed.actions.add(hostTools());
  await store.ensureSchema();
  return { vendo: composed, store };
}

describe("the INTERNAL-only door — one credential space, and no way into the other", () => {
  it("CONTROL · a live turn's credential goes straight through: the door is mounted and it works", async () => {
    let answered: { isError?: boolean; text: string } | undefined;
    const { vendo, store } = await internalHost(async (door) => {
      answered = await door.callTool(READ_TOOL, { query: "balance" });
    });

    const rows = await rowsAddedBy(store, READ_TOOL, async () => {
      await runHarnessTurn(vendo, "thr_internal_ok", "look it up");
    });

    expect(answered?.isError).toBeFalsy();
    expect(rows).toHaveLength(1);
    // The TURN's own accountability context, unchanged by this lane: a chat
    // turn's call audits `venue: "chat"`, never the door's `mcp`.
    expect(shapeOf(rows[0])).toEqual({
      outcome: "ok",
      decidedBy: "rule",
      presence: "present",
      venue: "chat",
      subject: SUBJECT,
    });
  });

  it("no discovery: every document that would tell a client this door exists is 404", async () => {
    const { vendo } = await internalHost();
    for (const path of [
      "/.well-known/oauth-protected-resource/api/vendo/mcp",
      "/.well-known/oauth-authorization-server/api/vendo/mcp",
      "/.well-known/mcp/server-card.json",
      "/.well-known/mcp-server-card",
    ]) {
      const answered = await vendo.handler(new Request(`${ORIGIN}${path}`));
      expect(answered.status, path).toBe(404);
    }
  });

  it("no authorization server: register, authorize, token, revoke, federate and the connect page are all 404", async () => {
    const { vendo } = await internalHost();
    const attempts: Array<[string, Request]> = [
      ["register", new Request(`${MOUNT}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "outside", redirect_uris: ["https://client.example/cb"] }),
      })],
      ["authorize", new Request(`${MOUNT}/authorize?response_type=code&client_id=x&redirect_uri=https%3A%2F%2Fclient.example%2Fcb`)],
      ["token", new Request(`${MOUNT}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=x&client_id=x",
      })],
      ["revoke", new Request(`${MOUNT}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "token=x",
      })],
      ["federate", new Request(`${MOUNT}/federate?token=x`)],
      ["connect", new Request(`${MOUNT}/connect`)],
    ];
    for (const [name, request] of attempts) {
      const answered = await vendo.handler(request);
      expect(answered.status, name).toBe(404);
    }
  });

  it("the ONLY way an outside bearer can exist — register → authorize → token — cannot even start", async () => {
    const { vendo } = await internalHost();
    await expect(bearer(vendo)).rejects.toThrow();
  });

  it("no bearer at the mount is a FLAT 401: no challenge, so nothing names a place to sign in", async () => {
    const { vendo } = await internalHost();
    const answered = await vendo.handler(mcpRequest());
    expect(answered.status).toBe(401);
    // A full door answers with `Bearer resource_metadata="…"`, which is the
    // thread a client pulls to discover the authorization server and register
    // itself. There is no such thread here.
    expect(answered.headers.get("www-authenticate")).toBeNull();
  });

  it("an invented bearer is the same flat 401 — including one shaped like a turn credential", async () => {
    const { vendo } = await internalHost();
    for (const invented of ["vtk_looks-like-a-turn-credential", "mcpa_an-access-token", "totally-made-up"]) {
      const answered = await vendo.handler(mcpRequest(invented));
      expect(answered.status, invented).toBe(401);
      expect(answered.headers.get("www-authenticate"), invented).toBeNull();
    }
  });

  it("no session, so no listing: tools/list without a turn credential never reaches a tool name", async () => {
    const { vendo } = await internalHost();
    const answered = await vendo.handler(mcpRequest(undefined, rpcBody("tools/list")));
    expect(answered.status).toBe(401);
    expect(await answered.text()).not.toContain(READ_TOOL);
    // And no session id was ever handed out to drive one with.
    expect(answered.headers.get("mcp-session-id")).toBeNull();
  });

  it("the product never advertises an MCP surface: `mcp: true` remains the ONLY thing that says so", async () => {
    const { vendo } = await internalHost();
    const answered = await vendo.handler(new Request(`${ORIGIN}/api/vendo/status`));
    expect(answered.status).toBe(200);
    const status = (await answered.json()) as { blocks?: { mcp?: boolean } };
    expect(status.blocks?.mcp).toBe(false);
  });

  it("a harness that needs no door gets NO door: the mount is simply not there", async () => {
    const store = await tempStore();
    const harness = defineHarness({
      name: "in-process-probe",
      async *run() {
        yield { type: "text", delta: "done" };
      },
    });
    const vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store,
      harness: harness as never,
    } as Parameters<typeof createVendo>[0]);
    await store.ensureSchema();

    const answered = await vendo.handler(mcpRequest());
    // Not 401 — 404. An unmounted route, exactly as before this lane.
    expect(answered.status).toBe(404);
  });
});

/**
 * WHERE the harness dials, which is the other half of "zero extra config".
 *
 * A door that exists and cannot be reached is the same as no door, so the goal
 * is only met if a machine-less `claudeCode()` finds its own host with nothing
 * set. It does that by learning the origin the wire was reached at — and that
 * origin is derived from the HOST HEADER, which is attacker-controllable.
 *
 * The first shipping of this rule was poisonable: in development with no
 * `VENDO_BASE_URL`, ONE request carrying `Host: attacker.evil` fixed the origin
 * process-wide, after which the harness sent `Authorization: Bearer vtk_…` and
 * every tool call to the attacker. It also reached `mcp: true` compositions,
 * because the rule is about the HARNESS's door target, not about which door
 * shape was mounted.
 *
 * So the learned origin is now LOOPBACK-ONLY, and the first qualifying request
 * fixes it: a non-loopback Host is never a candidate, and a later loopback Host
 * cannot replace an earlier one. `localhost` is where a machine-less thinker's
 * subprocess actually lives, so nothing about zero-config dev is lost.
 */
async function dialledDoorUrl(
  requires: { toolDoor: true; sandbox?: true },
  config: Record<string, unknown> = {},
  origins: string[] = [ORIGIN],
): Promise<string | undefined> {
  const store = await tempStore();
  let dialled: string | undefined;
  const harness = defineHarness({
    name: "door-url-probe",
    requires,
    async *run() {
      dialled = harnessAdapters(harness).toolDoor?.url;
      yield { type: "text", delta: "done" };
    },
  });
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store,
    harness: harness as never,
    // Only so the boot gate has a machine to approve; nothing here runs a box.
    ...(requires.sandbox === true ? { sandbox: {} } : {}),
    // NODE_ENV=development also arms source capture, which is unrelated.
    development: false,
    ...config,
  } as Parameters<typeof createVendo>[0]);
  await store.ensureSchema();
  // Every origin but the last only teaches; the last one runs the probe turn.
  // A Host header is exactly what an `origin` is here — this IS the attack.
  for (const [index, origin] of origins.entries()) {
    const response = await vendo.handler(new Request(`${origin}/api/vendo/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: `thr_door_url_${index}`,
        message: { id: `m_${index}`, role: "user", parts: [{ type: "text", text: "hi" }] },
      }),
    }));
    await response.text();
  }
  return dialled;
}

const LOOPBACK = "http://127.0.0.1:3000";
const ATTACKER = "https://attacker.evil";

/** The port's own account of WHO mounted it, read from inside a live turn. */
async function mountedAutoMounted(
  config: Record<string, unknown> = {},
): Promise<boolean | undefined> {
  const store = await tempStore();
  let seen: boolean | undefined;
  const harness = defineHarness({
    name: "door-auto-mounted-probe",
    requires: { toolDoor: true },
    async *run() {
      seen = harnessAdapters(harness).toolDoor?.autoMounted;
      yield { type: "text", delta: "done" };
    },
  });
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store,
    harness: harness as never,
    development: false,
    ...config,
  } as Parameters<typeof createVendo>[0]);
  await store.ensureSchema();
  const response = await vendo.handler(new Request(`${ORIGIN}/api/vendo/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thr_auto_mounted",
      message: { id: "m_auto", role: "user", parts: [{ type: "text", text: "hi" }] },
    }),
  }));
  await response.text();
  return seen;
}

describe("the door port says WHO mounted it — the fact the no-origin refusal turns on", () => {
  it("a host that never configured `mcp` gets an AUTO-MOUNTED port, so a missing origin is workspace-only, not a refusal", async () => {
    // The harness asked for a door (`requires.toolDoor`); the host asked for
    // nothing. Composition is the only layer that can tell those apart, so it
    // states the fact rather than leaving the harness to infer it from
    // `machine`, which stopped being a proxy for it once `claudeCode()`
    // declared `requires.toolDoor` unconditionally.
    expect(await mountedAutoMounted()).toBe(true);
  });

  it("a host that DID configure `mcp` gets a host-configured port, so an unreachable door still refuses", async () => {
    expect(await mountedAutoMounted({
      mcp: true,
      oauth: {
        async authorize() { return { subject: SUBJECT }; },
        async principal(subject: string) { return { kind: "user", subject }; },
      },
    })).toBe(false);
  });
});

describe("where an internal door is dialled — zero config, and not poisonable by a Host header", () => {
  it("ZERO CONFIG: a machine-less harness with no configured base dials this host's own LOOPBACK origin", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VENDO_BASE_URL", "");
    expect(await dialledDoorUrl({ toolDoor: true }, {}, [LOOPBACK]))
      .toBe(`${LOOPBACK}/api/vendo/mcp`);
  });

  it("ATTACK: a spoofed non-loopback Host NEVER becomes the tool-door origin", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VENDO_BASE_URL", "");
    // One request was all it took: the credential and every tool call would have
    // gone to `https://attacker.evil/api/vendo/mcp`.
    expect(await dialledDoorUrl({ toolDoor: true }, {}, [ATTACKER])).toBeUndefined();
    // Not even a plausible-looking public origin — nothing but loopback counts.
    expect(await dialledDoorUrl({ toolDoor: true }, {}, [ORIGIN])).toBeUndefined();
  });

  it("ATTACK: a spoofed Host cannot REPLACE an origin already learned, in either order", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VENDO_BASE_URL", "");
    // Poison after: the real origin was learned first and is fixed.
    expect(await dialledDoorUrl({ toolDoor: true }, {}, [LOOPBACK, ATTACKER]))
      .toBe(`${LOOPBACK}/api/vendo/mcp`);
    // Poison first: it was never a candidate, so the real origin still lands.
    expect(await dialledDoorUrl({ toolDoor: true }, {}, [ATTACKER, LOOPBACK]))
      .toBe(`${LOOPBACK}/api/vendo/mcp`);
    // And one loopback port cannot be swapped for another.
    expect(await dialledDoorUrl({ toolDoor: true }, {}, [LOOPBACK, "http://127.0.0.1:9999"]))
      .toBe(`${LOOPBACK}/api/vendo/mcp`);
  });

  it("the SAME rule governs an `mcp: true` composition — this is about the harness, not the door shape", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VENDO_BASE_URL", "");
    const withDoor = {
      mcp: true,
      oauth: {
        async authorize() { return { subject: SUBJECT }; },
        async principal(subject: string) { return { kind: "user", subject }; },
      },
    };
    expect(await dialledDoorUrl({ toolDoor: true }, withDoor, [ATTACKER])).toBeUndefined();
    expect(await dialledDoorUrl({ toolDoor: true }, withDoor, [LOOPBACK]))
      .toBe(`${LOOPBACK}/api/vendo/mcp`);
  });

  it("a harness that needs a MACHINE is NEVER handed a learned origin — only an operator-set one", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VENDO_BASE_URL", "");
    // The deployment gap this lane keeps: a box cannot dial a door nobody can
    // name, and loopback is not an origin a box could reach anyway.
    expect(await dialledDoorUrl({ toolDoor: true, sandbox: true }, {}, [LOOPBACK])).toBeUndefined();
  });

  it("outside development a learned origin is not trusted for the door either", async () => {
    vi.stubEnv("VENDO_BASE_URL", "");
    expect(await dialledDoorUrl({ toolDoor: true }, {}, [LOOPBACK])).toBeUndefined();
  });

  it("an operator-set base wins on both legs, and over anything learned", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VENDO_BASE_URL", "https://app.example.com");
    expect(await dialledDoorUrl({ toolDoor: true }, {}, [LOOPBACK]))
      .toBe("https://app.example.com/api/vendo/mcp");
    expect(await dialledDoorUrl({ toolDoor: true, sandbox: true }, {}, [LOOPBACK]))
      .toBe("https://app.example.com/api/vendo/mcp");
  });
});
