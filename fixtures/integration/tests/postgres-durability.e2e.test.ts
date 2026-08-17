/** J9 — POSTGRES DURABILITY: the core journeys on real Postgres + a restart drill.
 *
 * Every other journey backs the composed store with a per-test PGlite temp dir.
 * This one runs the SAME whole-product flows (chat-generates-app + an away
 * automation) against REAL Postgres — the production backend — through the public
 * wire, then proves durability across a serving-process restart:
 *
 *   - commit real writes over the wire (an app row, an away run) on Postgres,
 *   - tear the serving stack down entirely (wire server + connection pool gone —
 *     a crash/restart), and
 *   - open a BRAND-NEW store against the same POSTGRES_URL and assert the
 *     committed rows survived exactly (durability, 02-store §2).
 *
 * Gated on POSTGRES_URL: without it (local default) the suite skips like the
 * store package's postgres-gate; the CI integration job provisions postgres:16
 * and sets POSTGRES_URL, so the journey code is real and runs there.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationTask } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import {
  ADA,
  createStack,
  decideApprovals,
  screenAgentCreateTurns,
  createAutomation,
  readSse,
  resetFixture,
  textTurn,
  toolCallTurn,
  waitForRunStatus,
  type Stack,
  type WireApproval,
} from "../src/harness.js";

const POSTGRES_URL = process.env.POSTGRES_URL;
const CREATE = "host_invoices_create";
const EVENT = "j9.invoice.ready";

/** The screen as the one engine now writes it: an `app.tsx` React component the
 *  gauntlet compiles, type-checks and renders. This suite only runs where
 *  POSTGRES_URL is set — which CI provides — so a wire document here fails the
 *  required `integration` check while passing (skipped) on a laptop. */
const CREATE_SCREEN = `import { Disclaimer, Stack, Text } from "@vendo/screen";

export default function AdaDurableCard() {
  return (
    <Stack gap={12}>
      <Text text="Durable Ada" variant="heading" />
      <Disclaimer reason="Fixture app." />
    </Stack>
  );
}
`;

const invoiceTask: AutomationTask = {
  kind: "steps",
  steps: [{
    id: "create",
    tool: CREATE,
    args: { customerId: "'cus_j9'", amountCents: "909", currency: "'USD'", memo: "'J9 durable invoice'" },
  }],
};

const TRUNCATE = "TRUNCATE vendo_apps, vendo_automations, vendo_threads, vendo_runs, vendo_grants, vendo_approvals, vendo_audit RESTART IDENTITY CASCADE";

async function rawQuery<Row>(store: ReturnType<typeof createStore>, query: string, params: unknown[] = []): Promise<Row[]> {
  const raw = store.raw() as { query(q: string, p?: unknown[]): Promise<{ rows: Row[] }> };
  return (await raw.query(query, params)).rows;
}

let stack: Stack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

describe.skipIf(!POSTGRES_URL)("J9: core journeys on Postgres survive a serving-process restart", () => {
  it("commits an app + an away run over the wire on Postgres, then reopens and finds them intact", async () => {
    const url = POSTGRES_URL!;
    await resetFixture();

    // Clean slate on the shared Postgres instance.
    const pre = createStore({ url });
    await pre.ensureSchema();
    await rawQuery(pre, TRUNCATE);
    await pre.close();

    stack = await createStack({
      storeUrl: url,
      turns: [
        toolCallTurn("vendo_make", { request: "Build a durable card" }, "call_app"),
        // The screen agent answers this ask itself (it is THE engine for a
        // `vendo_make` now), so the conductor spends no generation turns.
        ...screenAgentCreateTurns(CREATE_SCREEN),
        textTurn("Created your durable app.", "t1"),
      ],
    });

    // --- Core journey 1: chat generates an app (persisted to Postgres) --------
    const turn = await readSse(await stack.wireFetch("/threads", {
      method: "POST",
      body: JSON.stringify({
        threadId: "thr_j9",
        message: { id: "u1", role: "user", parts: [{ type: "text", text: "Build a durable card" }] },
      }),
    }, ADA));
    expect(turn.raw.includes("Created your durable app.")).toBe(true);
    // Capture the generated app before authoring the automation (only row so far).
    const apps = await stack.sql<{ id: string; subject: string }>("SELECT id, subject FROM vendo_apps");
    expect(apps).toHaveLength(1);
    const appId = apps[0]!.id;
    expect(apps[0]!.subject).toBe(ADA.subject);

    // --- Core journey 2: an away automation run (persisted to Postgres) --------
    const automation = await createAutomation(stack, {
      owner: ADA,
      when: { event: EVENT },
      task: invoiceTask,
    });
    const enabled = (await (await stack.wireFetch(`/automations/${automation.id}/enable`, { method: "POST" }, ADA)).json()) as {
      enabled: boolean;
      missing: WireApproval[];
    };
    expect(enabled.enabled).toBe(true);
    await decideApprovals(stack, enabled.missing.map((request) => request.id), { approve: true }, ADA);
    const runIds = await stack.vendo.emit(EVENT, { by: "j9" }, ADA);
    expect(runIds).toHaveLength(1);
    const runId = runIds[0]!;
    await waitForRunStatus(stack, runId, ADA, "ok");

    // --- Restart drill: tear the serving stack down (pool + server gone) -------
    await stack.close();
    stack = undefined;

    // --- A brand-new connection finds every committed row intact --------------
    const reopened = createStore({ url });
    await reopened.ensureSchema();
    try {
      const appRows = await rawQuery<{ id: string; subject: string }>(
        reopened, "SELECT id, subject FROM vendo_apps WHERE id = $1", [appId],
      );
      expect(appRows).toEqual([{ id: appId, subject: ADA.subject }]);

      // A run belongs to the RECORD that fired it — `vendo_runs` re-keyed
      // `app_id` to `automation_id`, because an automation holds no app at all.
      const runRows = await rawQuery<{ id: string; status: string; automation_id: string }>(
        reopened, "SELECT id, status, automation_id FROM vendo_runs WHERE id = $1", [runId],
      );
      expect(runRows).toEqual([{ id: runId, status: "ok", automation_id: automation.id }]);

      // The captured standing grant survived too (automation authority is durable).
      const grants = await rawQuery<{ tool: string; source: string }>(
        reopened, "SELECT tool, source FROM vendo_grants WHERE automation_id = $1", [automation.id],
      );
      expect(grants).toContainEqual({ tool: CREATE, source: "automation" });
    } finally {
      await reopened.close();
    }
  });
});
