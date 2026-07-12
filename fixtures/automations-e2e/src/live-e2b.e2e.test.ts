/** Live leg (E2B_API_KEY-gated): the 07 §4 v0 rule end to end — "wake my
 * machine" as a steps pipeline whose fn: step reaches a REAL e2b machine
 * through the apps runtime, with the machine's output feeding a later host
 * tool call against the live fixture.
 */
import { describe, expect, it } from "vitest";
import { e2bSandbox } from "@vendoai/apps/e2b";
import type { SandboxMachine } from "@vendoai/apps";
import { automationDoc, createStack, loginCookie, fixtureBaseUrl, ownerCtx, resetFixture } from "./harness.js";
import { ADA, approve } from "./support.js";

const liveKey = process.env.E2B_API_KEY;
const plausible = typeof liveKey === "string" && liveKey.length > 10;

/** A minimal machine app: POST /fn/main answers the 06 §4.1 result envelope. */
const serverSource = `
const http = require("node:http");
http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    let args = {};
    try { args = JSON.parse(Buffer.concat(chunks).toString() || "{}").args ?? {}; } catch {}
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ result: { echo: args.note ?? null, from: "machine" } }));
  });
}).listen(Number(process.env.PORT || 8080));
`;

async function readyEventually(machine: SandboxMachine): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await machine.request({
        method: "POST",
        path: "/fn/main",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args: { note: "ready?" } }),
      });
      if (response.status === 200) return;
    } catch (error) {
      failure = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw failure ?? new Error("e2b fn server did not become ready");
}

describe.skipIf(!plausible)("live e2b fn: automation", () => {
  it("runs a single fn:main step against a real machine and feeds its output onward", { timeout: 300_000 }, async () => {
    await resetFixture();
    const adapter = e2bSandbox({ apiKey: liveKey as string, timeoutMs: 120_000 });
    const machine = await adapter.create({
      env: { PORT: "8080" },
      files: { "/app/server.js": serverSource },
    });
    let snapshotRef: string | undefined;
    try {
      const boot = await machine.exec("nohup node /app/server.js >/tmp/vendo-live-fn.log 2>&1 &", {
        cwd: "/app",
        timeoutMs: 10_000,
      });
      expect(boot.code).toBe(0);
      await readyEventually(machine);
      // snapshot() pauses the sandbox — the paused sandbox IS the snapshot.
      // Stopping it here would destroy what the automation must resume.
      snapshotRef = await machine.snapshot();
    } catch (error) {
      await machine.stop().catch(() => undefined);
      throw error;
    }

    const stack = await createStack({ sandbox: adapter });
    try {
      const appId = "app_live_e2b";
      const doc = automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "live.e2b" },
          run: {
            kind: "steps",
            steps: [
              { id: "main", tool: "fn:main", args: { note: "event.note" } },
              {
                id: "record",
                tool: "host_invoices_create",
                args: {
                  customerId: "'cus_ada'",
                  amountCents: "1",
                  memo: "steps.main.echo & ' via ' & steps.main.from",
                },
              },
            ],
          },
        },
      });
      await stack.putApp(ADA.subject, { ...doc, server: snapshotRef });

      const enabled = await stack.automations.enable(appId, ownerCtx(ADA.subject, appId));
      // fn: steps need no grant — only the host write is captured.
      expect(enabled.missing.map((request) => request.call.tool)).toEqual(["host_invoices_create"]);
      await approve(stack, enabled.missing);

      const runIds = await stack.automations.emit("live.e2b", { note: "wave4-live" }, ADA);
      expect(runIds).toHaveLength(1);

      const runId = runIds[0] as string;
      let row: { status: string; record: unknown } | undefined;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const rows = await stack.sql<{ status: string; record: unknown }>(
          "SELECT status, record FROM vendo_runs WHERE id = $1",
          [runId],
        );
        row = rows[0];
        if (row !== undefined && row.status !== "running" && row.status !== "pending-approval") break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (row?.status !== "ok") {
        throw new Error(`live e2b run did not reach ok: ${JSON.stringify(row)}`);
      }

      const cookie = await loginCookie(ADA.subject);
      const response = await fetch(`${fixtureBaseUrl()}/api/invoices`, { headers: { cookie } });
      const body = (await response.json()) as { invoices: Array<{ memo: string }> };
      expect(body.invoices.some((invoice) => invoice.memo === "wave4-live via machine")).toBe(true);
    } finally {
      await stack.close();
      // Kill the paused/resumed sandbox so live runs don't leak machines.
      try {
        const leftover = await adapter.resume(snapshotRef);
        await leftover.stop();
      } catch {
        // Already gone (or resumed and timed out) — nothing to clean.
      }
    }
  });
});
