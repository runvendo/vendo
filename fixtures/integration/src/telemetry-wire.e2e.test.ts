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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_ALLOWLIST, type EventName } from "@vendoai/telemetry";
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
