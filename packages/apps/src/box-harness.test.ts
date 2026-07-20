import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// The box harness ships as zero-dependency runtime .mjs baked into the base
// template; it is exercised here through its side-effect-free factory.
import { createHarness } from "../box/harness.mjs";

/** Drive one harness on an ephemeral port against a scripted agent engine. */
const withHarness = async (
  runAgentTask: (input: { prompt: string; context?: string; env: Record<string, string> }) => Promise<unknown>,
  body: (base: string, harness: ReturnType<typeof createHarness>) => Promise<void>,
): Promise<void> => {
  const appDir = mkdtempSync(path.join(tmpdir(), "vendo-box-"));
  const harness = createHarness({
    appDir,
    controlPort: 0,
    runAgentTask: runAgentTask as never,
    baseEnv: { VENDO_INFERENCE_URL: "http://model.test", VENDO_INFERENCE_KEY: "k" },
  });
  await harness.start();
  const address = harness.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    await body(`http://127.0.0.1:${port}`, harness);
  } finally {
    await harness.stop();
  }
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("box control-port protocol", () => {
  it("reports health", async () => {
    await withHarness(async () => ({ ok: true, summary: "", filesChanged: [], testsRun: 0 }), async (base) => {
      const response = await fetch(`${base}/agent/health`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.harness).toBe("vendo-box/1");
    });
  });

  it("runs a task to a structured result the host polls", async () => {
    const seen: { prompt?: string; context?: string; token?: string } = {};
    await withHarness(async (input) => {
      seen.prompt = input.prompt;
      seen.context = input.context;
      seen.token = input.env.VENDO_APP_TOKEN;
      return { ok: true, summary: "wrote chaseInvoices", filesChanged: ["/app/server.js"], testsRun: 1, fns: ["chaseInvoices"] };
    }, async (base, harness) => {
      const started = await fetch(`${base}/agent/task`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "build a chaser", context: "SKIN CONTRACT ..." }),
      });
      expect(started.status).toBe(202);
      const { taskId } = await started.json();
      expect(taskId).toMatch(/^boxtask_/);
      await harness.taskPromise(taskId);
      const polled = await fetch(`${base}/agent/task/${taskId}`);
      const body = await polled.json();
      expect(body.status).toBe("done");
      expect(body.result).toEqual({
        ok: true,
        summary: "wrote chaseInvoices",
        filesChanged: ["/app/server.js"],
        testsRun: 1,
        fns: ["chaseInvoices"],
      });
      expect(seen.prompt).toBe("build a chaser");
      expect(seen.context).toBe("SKIN CONTRACT ...");
    });
  });

  it("refuses a second concurrent task with 409", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await withHarness(async () => {
      await gate;
      return { ok: true, summary: "", filesChanged: [], testsRun: 0 };
    }, async (base, harness) => {
      const first = await (await fetch(`${base}/agent/task`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "one" }),
      })).json();
      const second = await fetch(`${base}/agent/task`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "two" }),
      });
      expect(second.status).toBe(409);
      release();
      await harness.taskPromise(first.taskId);
    });
  });

  it("rejects a task with no prompt", async () => {
    await withHarness(async () => ({ ok: true, summary: "", filesChanged: [], testsRun: 0 }), async (base) => {
      const response = await fetch(`${base}/agent/task`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "" }),
      });
      expect(response.status).toBe(400);
    });
  });

  it("persists re-injected env and exposes it to the next task (grant-flip restart loop)", async () => {
    const envSeen: Array<string | undefined> = [];
    await withHarness(async (input) => {
      envSeen.push(input.env.RESEND_API_KEY);
      return { ok: true, summary: "", filesChanged: [], testsRun: 0 };
    }, async (base, harness) => {
      // First task: no secret granted yet.
      const t1 = await (await fetch(`${base}/agent/task`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "one" }),
      })).json();
      await harness.taskPromise(t1.taskId);
      // Grant flips: host re-injects env (Lane E commitExposure → box restart loop).
      const env = await fetch(`${base}/agent/env`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ env: { RESEND_API_KEY: "granted-value" } }),
      });
      expect(env.status).toBe(200);
      const t2 = await (await fetch(`${base}/agent/task`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "two" }),
      })).json();
      await harness.taskPromise(t2.taskId);
      expect(envSeen[0]).toBeUndefined();
      expect(envSeen[1]).toBe("granted-value");
    });
  });

  it("supervises the app from the .vendo/run Procfile entry", async () => {
    const appDir = mkdtempSync(path.join(tmpdir(), "vendo-box-"));
    const marker = path.join(appDir, "started.txt");
    // createHarness() creates .vendo/; write the Procfile entry before start().
    const harness = createHarness({ appDir, controlPort: 0, runAgentTask: (async () => ({ ok: true, summary: "", filesChanged: [], testsRun: 0 })) as never });
    cleanups.push(() => harness.stop());
    writeFileSync(path.join(appDir, ".vendo", "run"), `printf ran > ${JSON.stringify(marker)}; sleep 30`);
    await harness.start();
    // The supervisor spawns the entry on start; poll for the marker (bash -lc
    // login-shell startup varies under load).
    for (let i = 0; i < 60; i += 1) {
      try {
        if (readFileSync(marker, "utf8") === "ran") break;
      } catch {
        // Not written yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(readFileSync(marker, "utf8")).toBe("ran");
  });
});
