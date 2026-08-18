import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApps } from "@vendoai/apps";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Json,
  type Principal,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import { screenSource } from "./screen-fixture.js";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Risk-grading redesign, checker finding 1 — the app-venue dead approval loop.
 *
 * An `ungraded` tool asks by default (D3), and an app's QUERIES go through the
 * guard like everything else. A parked query is never re-dispatched the way a
 * mutating action is — it has no effect to land, the surface just re-reads — so
 * the owner's yes only counts if the REFETCH can ride the approval. The guard's
 * approved replay pins the call id (05 §2), and the app caller used to mint a
 * fresh UUID per invocation: approve, reopen, miss, park again, forever — a
 * permanently empty region behind an endless stack of approval cards.
 *
 * Driven through the real public surface (`apps.open()`), on the real guard,
 * apps runtime, and store, wired the way the umbrella does.
 */

const principal: Principal = { kind: "user", subject: "user_query" };
const ctx: RunContext = {
  principal,
  venue: "app",
  presence: "present",
  sessionId: "session_query",
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A host with ONE ungraded read-shaped tool, counting every real execution. */
function insightsHost(): { tools: ToolRegistry; reads: () => number } {
  let reads = 0;
  const descriptor: ToolDescriptor = {
    name: "host_getSpendingInsights",
    description: "Category totals for the signed-in customer",
    inputSchema: { type: "object", properties: { window: { type: "string" } } },
    // Nobody graded it: no human, no judge, and a GET is not a protocol fact.
    risk: "ungraded",
  };
  return {
    reads: () => reads,
    tools: {
      async descriptors() {
        return [descriptor];
      },
      async execute(call) {
        if (call.tool !== descriptor.name) {
          return { status: "error", error: { code: "not-found", message: `no tool ${call.tool}` } };
        }
        reads += 1;
        return { status: "ok", output: { dining: 41_200, groceries: 23_300 } };
      },
    },
  };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "vendo-ungraded-query-"));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const store = createStore({ dataDir: join(root, ".data") });
  cleanups.push(async () => store.close());
  await store.ensureSchema();
  // NO policy at all — the bare guard whose `ungraded` default is the point.
  const guard = createGuard({ store });
  const host = insightsHost();
  const apps = createApps({ store, guard, tools: guard.bind(host.tools), catalog: [] });
  const app = await apps.importApp(
    {
      format: VENDO_APP_FORMAT,
      id: "app_seed_id_is_replaced",
      name: "Spending view",
      ui: "tree",
      source: screenSource(`import { Stack, Text, useQuery } from "@vendo/screen";

export default function Spending() {
  const insights = useQuery("host_getSpendingInsights", { window: "30d" });
  return (
    <Stack gap={12}>
      <Text text={String(insights.dining) + " " + String(insights.groceries)} />
    </Stack>
  );
}
`),
    } as AppDocument,
    ctx,
  );
  return { guard, apps, host, appId: app.id };
}

/**
 * What the surface actually renders for the query's slot, or `undefined` when
 * the query has nothing to give it.
 *
 * A screen's tree is what RENDERING it produces, so a query that parks takes the
 * whole render with it: the open refuses, in the gauntlet's own words, rather
 * than painting a screen with a hole in it.
 */
async function renderedInsights(
  apps: Awaited<ReturnType<typeof harness>>["apps"],
  appId: string,
): Promise<Json | undefined> {
  const surface = await apps.open(appId as Parameters<typeof apps.open>[0], ctx)
    .catch((thrown: unknown) => {
      // The ONE refusal that reads as "the region has nothing to show": THIS
      // query did not get an answer out of the guard. Every other way an open
      // can fail is a real break, and swallowing it would make the
      // `toBeUndefined`s below pass for a reason nobody named.
      const said = thrown instanceof Error ? thrown.message : String(thrown);
      if (!said.includes('the query useQuery("host_getSpendingInsights"')) throw thrown;
      return undefined;
    });
  if (surface === undefined) return undefined;
  if (surface.kind !== "tree") throw new Error(`expected a tree surface, got ${surface.kind}`);
  return JSON.stringify(surface.payload) as Json;
}

async function onlyPendingApproval(guard: Awaited<ReturnType<typeof harness>>["guard"]) {
  const pending = await guard.approvals.pending(principal);
  expect(pending).toHaveLength(1);
  return pending[0]!.id;
}

describe.sequential("an ungraded app query parks, and the owner's yes actually lands", () => {
  it("open → park → approve → reopening renders real data", async () => {
    const { guard, apps, host, appId } = await harness();

    // First open: the ungraded query parks, so the region has nothing to show.
    expect(await renderedInsights(apps, appId)).toBeUndefined();
    expect(host.reads()).toBe(0);

    await guard.approvals.decide(await onlyPendingApproval(guard), { approve: true }, principal);

    // THE BUG: before the fix this reopen minted a new call id, missed the
    // approval, and parked again — the region stayed empty forever.
    expect(await renderedInsights(apps, appId)).toContain("41200 23300");
    expect(host.reads()).toBe(1);
  });

  it("a denied query never reads the host, and the no is DURABLE across reopens", async () => {
    const { guard, apps, host, appId } = await harness();

    expect(await renderedInsights(apps, appId)).toBeUndefined();
    await guard.approvals.decide(await onlyPendingApproval(guard), { approve: false }, principal);

    // Checker round 2, finding A: the stable query id used to mint a FRESH card
    // on every reopen — deny, reopen, new card, forever. The no now answers the
    // re-issue, so the region stays honestly empty and the queue stays clean.
    for (let reopen = 0; reopen < 3; reopen += 1) {
      expect(await renderedInsights(apps, appId)).toBeUndefined();
      expect(await guard.approvals.pending(principal)).toHaveLength(0);
    }
    expect(host.reads()).toBe(0);
  });

  it("a misclicked no is recoverable: revoke the decision and the region asks again", async () => {
    const { guard, apps, host, appId } = await harness();

    expect(await renderedInsights(apps, appId)).toBeUndefined();
    const denied = await onlyPendingApproval(guard);
    await guard.approvals.decide(denied, { approve: false }, principal);
    expect(await renderedInsights(apps, appId)).toBeUndefined();
    expect(await guard.approvals.pending(principal)).toHaveLength(0);

    // Checker round 3, finding 6 — without this the app's query is dead for
    // good, because its descriptor and call id never change.
    await guard.approvals.revoke(denied, principal);
    expect(await renderedInsights(apps, appId)).toBeUndefined();
    const reasked = await onlyPendingApproval(guard);
    await guard.approvals.decide(reasked, { approve: true }, principal);
    expect(await renderedInsights(apps, appId)).toContain("41200 23300");
    expect(host.reads()).toBe(1);
  });

  it("a standing grant is the durable answer — the surface stops asking entirely", async () => {
    const { guard, apps, host, appId } = await harness();

    expect(await renderedInsights(apps, appId)).toBeUndefined();
    // "Remember this decision" — the approval card's own affordance.
    await guard.approvals.decide(
      await onlyPendingApproval(guard),
      { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      principal,
    );

    for (let reopen = 0; reopen < 3; reopen += 1) {
      expect(await renderedInsights(apps, appId)).toContain("41200 23300");
    }
    expect(host.reads()).toBe(3);
    expect(await guard.approvals.pending(principal)).toHaveLength(0);
  });
});
