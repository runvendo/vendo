import { performance } from "node:perf_hooks";
import { e2bSandbox } from "@vendoai/apps/e2b";
import type { SandboxMachine } from "@vendoai/apps";
import { summarize } from "../stats.js";
import type { CaseResult, Suite, SuiteResult } from "../types.js";

const TRIALS = 5;
const decoder = new TextDecoder();

const serverSource = `
const http = require("node:http");
http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(Buffer.concat(chunks));
  });
}).listen(Number(process.env.PORT || 8080));
`;

/** Poll the machine until the in-sandbox HTTP server answers, returning the body. */
const requestEventually = async (machine: SandboxMachine): Promise<string> => {
  let failure: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await machine.request({ method: "POST", path: "/fn/echo", body: "e2b-bench" });
      if (response.status === 200) return decoder.decode(response.body);
    } catch (error) {
      failure = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw failure ?? new Error("e2b listener did not become ready");
};

/**
 * The truth about e2b wake latency (E2B_API_KEY required; never in CI).
 *
 * An e2b snapshot IS a paused sandbox (same id): snapshot() pauses, resume()
 * reconnects and unpauses. Per trial we pause, then time resume(ref) and the
 * resume→first-successful-request path, then re-pause for the next trial.
 * The 06 §1 "resuming" surface claims a ~1s wake — this measures the truth.
 */
export const e2bSuite: Suite = {
  name: "e2b",
  kind: "live",
  async run(): Promise<SuiteResult> {
    if (!process.env.E2B_API_KEY) {
      return { suite: "e2b", kind: "live", cases: [], skipped: true, reason: "E2B_API_KEY not set" };
    }

    const adapter = e2bSandbox({ apiKey: process.env.E2B_API_KEY, timeoutMs: 180_000 });
    const resumeMs: number[] = [];
    const wakeToServeMs: number[] = [];
    let live: SandboxMachine | undefined;

    try {
      // Boot once, start the server, confirm it serves.
      const machine = await adapter.create({ env: { PORT: "8080" }, files: { "/app/server.js": serverSource } });
      live = machine;
      const exec = await machine.exec("nohup node /app/server.js >/tmp/vendo-e2b-bench.log 2>&1 &", {
        cwd: "/app",
        timeoutMs: 10_000,
      });
      if (exec.code !== 0) throw new Error(`server start failed (${exec.code}): ${exec.stderr}`);
      await requestEventually(machine);

      let ref = await machine.snapshot(); // pause
      live = undefined;

      for (let trial = 0; trial < TRIALS; trial += 1) {
        const start = performance.now();
        const resumed = await adapter.resume(ref);
        resumeMs.push(performance.now() - start);
        live = resumed;
        await requestEventually(resumed);
        wakeToServeMs.push(performance.now() - start);
        ref = await resumed.snapshot(); // re-pause for the next trial
        live = undefined;
      }

      // The final ref is a paused sandbox — resume and kill it to clean up.
      const last = await adapter.resume(ref);
      await last.stop();
      live = undefined;

      const cases: CaseResult[] = [
        summarize("resume", resumeMs),
        summarize("resume-to-serve", wakeToServeMs),
      ];
      const p95 = cases[1]!.p95;
      const verdict =
        p95 <= 1500
          ? `Verdict: the ~1s wake claim HOLDS — resume→serve p95 = ${p95.toFixed(0)}ms.`
          : `Verdict: the ~1s wake claim is OPTIMISTIC — resume→serve p95 = ${p95.toFixed(0)}ms (${(p95 / 1000).toFixed(1)}x the claim).`;
      return { suite: "e2b", kind: "live", cases, notes: [verdict] };
    } finally {
      if (live !== undefined) await live.stop().catch(() => undefined);
    }
  },
};
