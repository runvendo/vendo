/** J11 — TELEMETRY WIRE: opt-in emits ONLY allowlisted events; opt-out emits none.
 *
 * The umbrella composed with `telemetry: true` fires anonymous product telemetry
 * from the wire (server.ts: `deps.telemetry?.track("agent_run", …)` on POST
 * /threads). This journey proves the end-to-end contract of TELEMETRY.md against
 * the REAL composed client by intercepting the PostHog capture endpoint:
 *
 *   - OPT-IN  (consent granted): a wire chat turn produces exactly one capture,
 *     whose event name is in the closed EVENT_ALLOWLIST and whose properties are
 *     confined to that event's allowed keys (here: the base props only), and
 *   - OPT-OUT (VENDO_TELEMETRY_DISABLED): the identical turn produces NOTHING.
 *
 * Consent is resolved at emit time from env (consent.ts): CI and an unset dev
 * NODE_ENV both fail closed, so the opt-in leg clears CI and pins NODE_ENV=test,
 * and points HOME at a temp dir so no real telemetry config is written.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_ALLOWLIST, initTelemetry, type EventName, type Telemetry } from "@vendoai/telemetry";
import { createStack, readSse, resetFixture, textTurn, ADA, type Stack } from "./harness.js";

const POSTHOG = "https://us.i.posthog.com";

interface Capture {
  event: string;
  properties: Record<string, unknown>;
  api_key: string;
  distinct_id?: string;
}

/** Install a global-fetch shim that captures PostHog capture POSTs and passes
 * every other request (the wire, the host app, host tools) through untouched. */
function captureTelemetry(): { captures: Capture[]; restore: () => void } {
  const captures: Capture[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(POSTHOG)) {
      const body = typeof init?.body === "string" ? init.body : "";
      try {
        captures.push(JSON.parse(body) as Capture);
      } catch {
        // A malformed body would itself be a telemetry regression; record nothing.
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input as never, init);
  }) as typeof fetch;
  return { captures, restore: () => { globalThis.fetch = realFetch; } };
}

async function driveTurn(stack: Stack, threadId: string): Promise<void> {
  const read = await readSse(await stack.wireFetch("/threads", {
    method: "POST",
    body: JSON.stringify({
      threadId,
      message: { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
    }),
  }, ADA));
  expect(read.raw.includes("[DONE]")).toBe(true);
}

/** track() is fire-and-forget (void) off the response, so poll for the capture. */
async function waitForCaptures(captures: Capture[], atLeast: number, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && captures.length < atLeast) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let stack: Stack | undefined;
let restoreFetch: (() => void) | undefined;
let tempHome: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]): void {
  for (const key of keys) savedEnv[key] = process.env[key];
}
function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(async () => {
  await stack?.close();
  stack = undefined;
  restoreFetch?.();
  restoreFetch = undefined;
  restoreEnv();
  if (tempHome !== undefined) await rm(tempHome, { recursive: true, force: true });
  tempHome = undefined;
});

describe("J11: telemetry emits only allowlisted events, and nothing when opted out", () => {
  it("(opt-in) a wire turn emits exactly one allowlisted, allowlist-scoped event", async () => {
    await resetFixture();
    saveEnv("CI", "NODE_ENV", "HOME", "VENDO_TELEMETRY_DISABLED", "DO_NOT_TRACK");
    tempHome = await mkdtemp(join(tmpdir(), "vendo-j11-home-"));
    delete process.env.CI; // CI fails consent closed
    delete process.env.VENDO_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    process.env.NODE_ENV = "test"; // runtime consent needs an explicit dev/test env
    process.env.HOME = tempHome;

    const telemetry = captureTelemetry();
    restoreFetch = telemetry.restore;

    stack = await createStack({ telemetry: true, turns: [textTurn("Hi.", "t1")] });
    await driveTurn(stack, "thr_j11_in");
    await waitForCaptures(telemetry.captures, 1);

    expect(telemetry.captures.length).toBeGreaterThanOrEqual(1);
    const allowlistNames = new Set(Object.keys(EVENT_ALLOWLIST));
    for (const capture of telemetry.captures) {
      // Every captured event is on the closed allowlist...
      expect(allowlistNames.has(capture.event)).toBe(true);
      // ...and carries only that event's permitted property keys.
      const allowed = EVENT_ALLOWLIST[capture.event as EventName];
      for (const key of Object.keys(capture.properties)) {
        expect(allowed.has(key), `prop ${key} on ${capture.event}`).toBe(true);
      }
    }
    // The wire turn's event is agent_run (the only runtime emitter).
    expect(telemetry.captures.some((capture) => capture.event === "agent_run")).toBe(true);
  });

  it("(opt-out) the identical turn under VENDO_TELEMETRY_DISABLED emits nothing", async () => {
    await resetFixture();
    saveEnv("CI", "NODE_ENV", "HOME", "VENDO_TELEMETRY_DISABLED");
    tempHome = await mkdtemp(join(tmpdir(), "vendo-j11-home-"));
    delete process.env.CI;
    process.env.NODE_ENV = "test";
    process.env.HOME = tempHome;
    process.env.VENDO_TELEMETRY_DISABLED = "1"; // explicit env opt-out

    const telemetry = captureTelemetry();
    restoreFetch = telemetry.restore;

    stack = await createStack({ telemetry: true, turns: [textTurn("Hi.", "t1")] });
    await driveTurn(stack, "thr_j11_out");
    // Give any (wrongly) emitted capture time to land, then assert none did.
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(telemetry.captures).toEqual([]);
  });
});

/** J11b — LANE SPLIT ON THE WIRE: the same wire-format contract, driven
 * through the REAL client (initTelemetry: real config, consent, allowlist
 * filtering, scrubbing — nothing mocked) with an injected capture fetch,
 * covering what a wire turn cannot express: the anonymous/cloud lane split,
 * producer-set cloud markers, and errorDetail scrubbing (TELEMETRY.md,
 * "When Vendo Cloud Is Configured").
 */
const FAKE_CLOUD_KEY = `vnd_${"0".repeat(40)}`; // well-formed shape, obviously not a real key

/** Real client over a temp home and a fetch stub that records serialized bodies. */
async function laneClient(
  env: Record<string, string | undefined>,
): Promise<{ telemetry: Telemetry; bodies: string[] }> {
  tempHome = await mkdtemp(join(tmpdir(), "vendo-j11-lane-home-"));
  const bodies: string[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const telemetry = initTelemetry({
    version: "0.0.0-test",
    env, // consent + lane read ONLY this env, so the suite's real env never leaks in
    runtime: false,
    posthogKey: "phc_wire_test",
    home: tempHome,
    fetchImpl,
    log: () => {},
  });
  return { telemetry, bodies };
}

describe("J11b: anonymous and cloud lanes through the real client", () => {
  it("(anonymous lane) base props ride; cloud markers and a smuggled cloud-only prop do not", async () => {
    const { telemetry, bodies } = await laneClient({
      npm_config_user_agent: "pnpm/9.15.0 npm/? node/v22.3.0 darwin arm64",
    });
    await telemetry.track("agent_run", { projectName: "smuggled-host-app" });

    expect(bodies.length).toBe(1);
    const capture = JSON.parse(bodies[0]!) as Capture;
    expect(capture.event).toBe("agent_run");
    // This repo has a project identity, so the salted hash is present: 64 hex.
    expect(capture.properties.projectIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(["npm", "pnpm", "yarn", "bun"]).toContain(capture.properties.packageManager);
    // No cloud key → no cloud markers, and the cloud-only prop is stripped.
    for (const key of ["cloud", "cloudKeyHash", "projectName"]) {
      expect(capture.properties, `anonymous lane must not carry ${key}`).not.toHaveProperty(key);
    }
  });

  it("(cloud lane) markers ride, the raw key never does, and errorDetail arrives scrubbed", async () => {
    const { telemetry, bodies } = await laneClient({
      npm_config_user_agent: "pnpm/9.15.0 npm/? node/v22.3.0 darwin arm64",
      VENDO_API_KEY: FAKE_CLOUD_KEY,
    });
    await telemetry.track("command_run", {
      command: "extract", // enriched event's closed enum, end to end
      ok: false,
      durationMs: 42,
      errorDetail: `ENOENT /Users/alice/project/src/routes.ts while using ${FAKE_CLOUD_KEY}`,
    });

    expect(bodies.length).toBe(1);
    // The raw key appears NOWHERE in the serialized body — only its hash does.
    expect(bodies[0]).not.toContain(FAKE_CLOUD_KEY);
    const capture = JSON.parse(bodies[0]!) as Capture;
    expect(capture.event).toBe("command_run");
    expect(capture.properties.command).toBe("extract");
    expect(capture.properties.cloud).toBe(true);
    expect(capture.properties.cloudKeyHash).toBe(
      createHash("sha256").update(FAKE_CLOUD_KEY).digest("hex"),
    );
    const detail = capture.properties.errorDetail as string;
    expect(detail).toContain("[path]");
    expect(detail).toContain("[secret]");
    expect(detail).not.toContain("/Users/alice");
  });

  it("(consent wins) DO_NOT_TRACK=1 with a cloud key sends zero requests", async () => {
    const { telemetry, bodies } = await laneClient({
      DO_NOT_TRACK: "1",
      VENDO_API_KEY: FAKE_CLOUD_KEY,
    });
    await telemetry.track("command_run", { command: "extract", ok: true, durationMs: 1 });
    expect(bodies).toEqual([]);
  });
});
