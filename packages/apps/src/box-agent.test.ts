import { describe, expect, it } from "vitest";
import { BOX_CONTROL_PORT, pushBoxEnv, readBoxManifest, requestAppWithBootRetry, runBoxEdit, type BoxAgentClock } from "./box-agent.js";
import type { SandboxMachine } from "./sandbox.js";
import { fakeBoxSandbox } from "./testing/fake-box.js";

/** Instant clock so the poll loop runs without real time. */
const instantClock = (): BoxAgentClock => ({ sleep: async () => undefined, now: () => 0 });

const boxOf = async (agent?: Parameters<typeof fakeBoxSandbox>[0]["agent"]) => {
  const adapter = fakeBoxSandbox(agent === undefined ? {} : { agent });
  return adapter.create({ env: { PORT: "8080" } });
};

describe("box-agent control-port transport", () => {
  it("posts a task, polls to done, and returns the structured result", async () => {
    const machine = await boxOf(({ box }) => {
      box.fns.set("chaseInvoices", () => ({ chased: 3 }));
      box.manifest = { schedules: [{ cron: "0 8 * * *", fn: "chaseInvoices" }], egress: ["httpbin.org"] };
      return { ok: true, summary: "wrote chaseInvoices", filesChanged: ["/app/server.js"], testsRun: 2, fns: ["chaseInvoices"] };
    });
    const result = await runBoxEdit(machine, { prompt: "chase my invoices", context: "SKIN", clock: instantClock() });
    expect(result).toEqual({
      ok: true, summary: "wrote chaseInvoices", filesChanged: ["/app/server.js"], testsRun: 2, fns: ["chaseInvoices"],
    });
    // The fn the agent installed is now served on the app port.
    const fn = await machine.request({ method: "POST", path: "/fn/chaseInvoices", body: JSON.stringify({ args: {} }) });
    expect(JSON.parse(new TextDecoder().decode(fn.body))).toEqual({ result: { chased: 3 } });
  });

  it("reads the vendo.json the agent wrote", async () => {
    const machine = await boxOf(({ box }) => {
      box.manifest = { egress: ["api.example.com"] };
      return { ok: true, summary: "", filesChanged: [], testsRun: 0 };
    });
    await runBoxEdit(machine, { prompt: "x", clock: instantClock() });
    expect(readBoxManifest === undefined).toBe(false);
    expect(await readBoxManifest(machine)).toBe(JSON.stringify({ egress: ["api.example.com"] }));
  });

  it("passes the box's served-app declaration through as data (Wave 4 layer 3)", async () => {
    const machine = await boxOf(({ box }) => {
      box.pages.set("/", "<!doctype html><h1>Kanban</h1>");
      return { ok: true, summary: "serving a web app", filesChanged: ["/app/server.js"], testsRun: 3, servesUi: true };
    });
    const result = await runBoxEdit(machine, { prompt: "build a kanban web app", clock: instantClock() });
    expect(result.ok).toBe(true);
    expect(result.servesUi).toBe(true);
    // The page the agent installed is served on the app port (non-/fn path).
    const page = await machine.request({ method: "GET", path: "/" });
    expect(page.status).toBe(200);
    expect(new TextDecoder().decode(page.body)).toContain("Kanban");
    // A non-served edit carries no servesUi field at all.
    const fnOnly = await boxOf(() => ({ ok: true, summary: "fn only", filesChanged: [], testsRun: 0 }));
    expect(await runBoxEdit(fnOnly, { prompt: "x", clock: instantClock() })).not.toHaveProperty("servesUi");
  });

  it("surfaces a box failure as a non-ok result (caller rolls back)", async () => {
    const machine = await boxOf(() => ({ ok: false, summary: "the model gave up", filesChanged: [], testsRun: 0 }));
    const result = await runBoxEdit(machine, { prompt: "x", clock: instantClock() });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("the model gave up");
  });

  it("times out into a failed result when the task never completes", async () => {
    // A machine whose control port never reports done: poll past the deadline.
    let elapsed = 0;
    const clock: BoxAgentClock = { sleep: async (ms) => { elapsed += ms; }, now: () => elapsed };
    const stuck = {
      id: "stuck",
      async request(req: { path: string }) {
        const body = req.path === "/agent/task"
          ? { taskId: "t1" }
          : { status: "running" };
        return { status: req.path === "/agent/task" ? 202 : 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
      },
      snapshot: async () => "x",
      stop: async () => undefined,
      destroy: async () => undefined,
    };
    const result = await runBoxEdit(stuck as never, { prompt: "x", clock, timeoutMs: 10_000, pollIntervalMs: 1_000 });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/timed out/);
  });

  it("re-injects env through the control port", async () => {
    const machine = await boxOf();
    await pushBoxEnv(machine, { RESEND_API_KEY: "granted" });
    expect(machine.state.env.RESEND_API_KEY).toBe("granted");
  });

  it("uses the dedicated control port, not the app $PORT", () => {
    expect(BOX_CONTROL_PORT).toBe(8811);
  });

  it("retries the app port past a post-resume 502 boot race, then returns the ready response", async () => {
    // The app is still booting after a snapshot resume: two 502s, then 200.
    const statuses = [502, 502, 200];
    let calls = 0;
    const machine = {
      id: "boot",
      async request() {
        const status = statuses[Math.min(calls++, statuses.length - 1)] ?? 200;
        return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify({ result: { ready: true } })) };
      },
      url: async () => "https://8080-boot.test", snapshot: async () => "x", stop: async () => undefined, destroy: async () => undefined,
    } satisfies SandboxMachine;
    const answer = await requestAppWithBootRetry(machine, { method: "POST", path: "/fn/x" }, { attempts: 5, sleep: async () => undefined });
    expect(calls).toBe(3);
    expect(answer.status).toBe(200);
  });

  it("gives up after the retry budget and returns the last 502", async () => {
    const machine = {
      id: "stuck",
      async request() { return { status: 502, headers: {}, body: new Uint8Array() }; },
      url: async () => "https://8080-stuck.test", snapshot: async () => "x", stop: async () => undefined, destroy: async () => undefined,
    } satisfies SandboxMachine;
    const answer = await requestAppWithBootRetry(machine, { method: "GET", path: "/vendo.json" }, { attempts: 3, sleep: async () => undefined });
    expect(answer.status).toBe(502);
  });
});
