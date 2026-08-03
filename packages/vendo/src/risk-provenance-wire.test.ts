/**
 * §12's SECOND MECHANICAL VOTE is scoped to AI-ASSIGNED labels — build contract
 * §8 clarification (2026-07-31) — read at the REAL composition.
 *
 * The vote exists to catch an extractor or a connector mislabelling someone
 * else's API. A Vendo-authored tool's `risk` was hand-written and reviewed in
 * this repo, so for those the vote is not a second opinion at all: it is the
 * verb-shape heuristic, calibrated for extracted `noun_verb` host names, guessing
 * about names it was never calibrated for. `validate` and `search_components`
 * both end in a noun, so the read short-circuit missed them and the fail-closed
 * default called them `write` — and a `write` is a MUTATING call to everything
 * downstream of `resolvedRisk`: the guard writes it an effect-ledger row, and a
 * re-run of that call answers from the receipt instead of re-executing — so a
 * retried automation run re-validates nothing and reports the pre-retry verdict.
 *
 * Everything here reads the guard-bound registry a real `createVendo` produced,
 * because the unit-level vote and the composed one disagree: actions' registry
 * hands out `descriptorOf(...)`, a field WHITELIST, so a hand-built fixture
 * carries things the guard never sees (a host tool's `binding.method`, for one).
 *
 * The projected surface is read through a real harness turn — `turn.tools.list()`
 * is the "what is the model even offered" door, and the only public one that
 * forwards the run's ctx into `descriptors(ctx)` where THE LAW's filter lives.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASK_USER_TOOL,
  descriptorHash,
  resolvedRisk,
  type PermissionGrant,
  type Principal,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_prov" };
const APP_ID = "app_prov_1";

const chat = (overrides: Partial<RunContext> = {}): RunContext => ({
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "s_prov",
  ...overrides,
});

/** A real unattended firing, exactly as the automations engine assembles one:
 *  automation venue, nobody there, a run id (the only shape the effect ledger
 *  keys on — build contract §7) and the app the run belongs to. */
const awayRun = (overrides: Partial<RunContext> = {}): RunContext => ({
  principal,
  venue: "automation",
  presence: "away",
  sessionId: "sess_run_prov_1",
  appId: APP_ID as never,
  trigger: { kind: "schedule", runId: "run_prov_1" as never },
  ...overrides,
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-prov-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** A host tool through the EXTRACTION door — the AI-assigned path the second
 *  vote exists for. */
const extracted = (name: string, risk: ToolDescriptor["risk"]) => ({
  name,
  description: `host tool ${name}`,
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  risk,
  binding: { kind: "route" as const, method: "GET" as const, path: `/api/${name}`, argsIn: "query" as const },
});

/** A host tool through the `actions.add` door, executed in-process so a
 *  successful call is observable without a real HTTP round trip. `calls` counts
 *  executions, and the answer changes every time, so a LEDGER REPLAY (the same
 *  answer twice, one execution) is distinguishable from a real second call. */
function hostRegistry(descriptors: ToolDescriptor[]): ToolRegistry & { calls: number } {
  const registry = {
    calls: 0,
    async descriptors() {
      return descriptors;
    },
    async execute() {
      registry.calls += 1;
      return { status: "ok" as const, output: { attempt: registry.calls } };
    },
  };
  return registry;
}

const hostWrite: ToolDescriptor = {
  name: "maple_note_update",
  description: "update a note",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  risk: "write",
};

async function compose(
  overrides: Partial<Parameters<typeof createVendo>[0]> = {},
): Promise<{ vendo: Vendo; store: VendoStore }> {
  const store = await tempStore();
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    ...overrides,
  } as Parameters<typeof createVendo>[0]);
  await store.ensureSchema();
  return { vendo, store };
}

const byName = async (vendo: Vendo, ctx: RunContext): Promise<Map<string, ToolDescriptor>> =>
  new Map((await vendo.guardedTools.descriptors(ctx)).map((descriptor) => [descriptor.name, descriptor]));

/** What the model is OFFERED in a run — read from inside a real harness turn,
 *  the one public path that carries the run's ctx to `descriptors(ctx)`. */
async function offeredIn(ctx: RunContext, overrides: Partial<Parameters<typeof createVendo>[0]> = {}): Promise<{
  names: string[];
  vendo: Vendo;
}> {
  const names: string[] = [];
  const { vendo } = await compose({
    ...overrides,
    harness: defineHarness({
      name: "lister",
      async *run(turn) {
        for (const entry of await turn.tools.list()) names.push(entry.name);
        yield { type: "text", delta: "listed" };
      },
    }) as never,
  });
  const turn = await vendo.harness.stream({
    threadId: `thr_${ctx.presence}`,
    message: { id: "m1", role: "user", parts: [{ type: "text", text: "go" }] } as never,
    ctx,
  });
  await turn.text();
  return { names, vendo };
}

/** The authority an ENABLED automation carries: a standing, app-bound
 *  `source: "automation"` grant per tool it uses, reads included (05 §6 — an
 *  away run holds only grants captured while present and bound to the app).
 *  Seeded through the store the ceremony writes to, so the away run reaches
 *  `decidedBy: "grant"` and actually executes. */
async function seedAwayGrant(store: VendoStore, descriptor: ToolDescriptor): Promise<void> {
  const grant: PermissionGrant = {
    id: `grt_${descriptor.name}` as never,
    subject: principal.subject,
    tool: descriptor.name,
    descriptorHash: descriptorHash(descriptor),
    scope: { kind: "tool" },
    duration: "standing",
    appId: APP_ID as never,
    source: "automation",
    grantedAt: new Date().toISOString() as never,
  };
  await store.records("vendo_grants").put({
    id: grant.id,
    data: grant as never,
    refs: { subject: grant.subject, tool: grant.tool, app_id: APP_ID },
  });
}

describe("a Vendo-authored risk label is authoritative (contract §8, 2026-07-31)", () => {
  it("resolves validate and search_components as READS on the composed registry", async () => {
    const { vendo } = await compose();
    const tools = await byName(vendo, chat());

    for (const name of ["validate", "search_components"]) {
      const descriptor = tools.get(name);
      expect(descriptor?.risk, `${name} declares`).toBe("read");
      // The bug: the mechanical vote called both of these `write`, and
      // `resolvedRisk` takes the riskier vote.
      expect(descriptor === undefined ? undefined : resolvedRisk(descriptor), `${name} resolves`).toBe("read");
    }

    // The other two Vendo-authored labels are unchanged: `ask_user` was already
    // fixed (by the name special case this change generalizes), and arming future
    // unattended behaviour is still a write.
    const ask = tools.get(ASK_USER_TOOL);
    expect(ask === undefined ? undefined : resolvedRisk(ask)).toBe("read");
    const schedule = tools.get("schedule");
    expect(schedule === undefined ? undefined : resolvedRisk(schedule)).toBe("write");
  });

  it("is not carded by a host policy matching { risk: 'write' } — a host write tool is", async () => {
    const { vendo } = await compose({
      policy: { rules: [{ match: { risk: "write" }, action: "ask" }] },
    });
    vendo.actions.add(hostRegistry([hostWrite]));

    const verb = await vendo.guardedTools.execute(
      { id: "p1", tool: "search_components", args: { query: "chart" } },
      chat(),
    );
    // A component search is a question about the catalog, not an action.
    expect(verb.status).toBe("ok");

    // The control: the same policy DOES card a host write, so the rule is live.
    const host = await vendo.guardedTools.execute(
      { id: "p2", tool: "maple_note_update", args: { id: "n_1" } },
      chat(),
    );
    expect(host.status).toBe("pending-approval");
  });

  it("writes no effect-ledger row for a Vendo verb, while a host write in the same run does", async () => {
    // §12: "reads are silent, always". A ledger row for a read is not just a
    // stray write: the next identical call in the same run REPLAYS it, so a
    // re-validation after an edit would answer with the stale verdict.
    const { vendo, store } = await compose();
    vendo.actions.add(hostRegistry([hostWrite]));
    const composed = await byName(vendo, chat());
    await seedAwayGrant(store, composed.get("search_components") as ToolDescriptor);
    await seedAwayGrant(store, composed.get("maple_note_update") as ToolDescriptor);
    const ctx = awayRun();

    const verb = await vendo.guardedTools.execute(
      { id: "p3", tool: "search_components", args: { query: "chart" } },
      ctx,
    );
    expect(verb.status).toBe("ok");
    expect((await store.records("vendo_effects").list({})).records).toHaveLength(0);

    // The control: a real mutation in the SAME run is ledgered, so the ledger was
    // live for the read that wasn't.
    const host = await vendo.guardedTools.execute(
      { id: "p4", tool: "maple_note_update", args: { id: "n_1" } },
      ctx,
    );
    expect(host.status).toBe("ok");
    expect((await store.records("vendo_effects").list({})).records).toHaveLength(1);
  });

  it("keeps offering the verbs to an unattended run — a read is never withheld", async () => {
    const { names } = await offeredIn(awayRun());
    expect(names).toContain("validate");
    expect(names).toContain("search_components");
  });

  it("removes a real REPLAY, not just a stray row: a RE-RUN of a ledgered read never re-executes", async () => {
    // The harm the ledger row does, shown on the tool class that still has it —
    // an AI-assigned `read` whose name the vote cannot recognise. Re-running the
    // same call of the same run (same call id, which is what a retried run
    // replays — contract §7's ordinal is what keeps two DELIBERATE identical
    // calls apart) does not execute again: it answers from the receipt. That is
    // what `validate` did before this change — a half-failed automation run,
    // retried, answering with the verdict recorded before the retry's edits.
    const shaped: ToolDescriptor = {
      name: "maple_report_refresh",
      description: "recompute a report",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      risk: "read",
    };
    const { vendo, store } = await compose();
    const host = hostRegistry([shaped]);
    vendo.actions.add(host);
    const composed = await byName(vendo, chat());
    expect(resolvedRisk(composed.get("maple_report_refresh") as ToolDescriptor)).toBe("write");
    await seedAwayGrant(store, composed.get("maple_report_refresh") as ToolDescriptor);
    const ctx = awayRun();

    const call = { id: "p6", tool: "maple_report_refresh", args: {} };
    const first = await vendo.guardedTools.execute(call, ctx);
    const second = await vendo.guardedTools.execute(call, ctx);

    expect(host.calls).toBe(1);
    expect(second).toEqual(first);
    expect((await store.records("vendo_effects").list({})).records).toHaveLength(1);
  });
});

describe("fail-closed is untouched for every AI-assigned label", () => {
  it("keeps an EXTRACTED tool destructive when its name reads destructive, whatever it declares", async () => {
    const profile = { tools: [extracted("maple_account_delete", "read")] };
    const { vendo, store } = await compose({ profile });

    const descriptor = (await byName(vendo, chat())).get("maple_account_delete");
    expect(descriptor?.risk).toBe("read");
    expect(descriptor === undefined ? undefined : resolvedRisk(descriptor)).toBe("destructive");

    // THE LAW, both mechanisms: never projected into an unattended run...
    const away = await offeredIn(awayRun(), { profile });
    expect(away.names).toContain("validate");
    expect(away.names).not.toContain("maple_account_delete");
    // ...and refused if it gets there anyway. The grant is what makes this the
    // law's own case rather than the away-park default: with standing authority
    // the pipeline says RUN, and the law refuses over it (05 §6 / J5 case 3).
    await seedAwayGrant(store, descriptor as ToolDescriptor);
    const outcome = await vendo.guardedTools.execute(
      { id: "p5", tool: "maple_account_delete", args: { id: "acct_1" } },
      awayRun(),
    );
    expect(outcome.status).toBe("blocked");
  });

  it("keeps a host-registry tool destructive when its BINDING reads destructive", async () => {
    // An `actions.add` registry has no extraction binding for `descriptorOf` to
    // read, so it states the fact itself. `bindingRisk` carries only the two
    // values that ESCALATE, which is why a source that arrived as data is allowed
    // to set it: there is no value it could send to look safer than its name.
    const mutating = {
      name: "maple_thing_update",
      description: "update a thing",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      risk: "read",
      bindingRisk: "destructive",
    } as ToolDescriptor;
    const { vendo } = await compose();
    vendo.actions.add(hostRegistry([mutating]));

    const descriptor = (await byName(vendo, chat())).get("maple_thing_update");
    expect(descriptor === undefined ? undefined : resolvedRisk(descriptor)).toBe("destructive");
  });

  it("cannot be forged from descriptor DATA: a host tool claiming Vendo provenance is not believed", async () => {
    // Provenance is carried by a symbol only in-repo code can attach, so nothing
    // that arrives as data — extracted `.vendo/tools.json`, a connector catalog,
    // an override, the wire — can claim it. These are the data-shaped forgeries:
    // the string form of the brand key, and two plausible field names.
    const forged = {
      "vendoai.tool.authored": true,
      authored: "vendo",
      vendoAuthored: true,
    };
    const profile = { tools: [{ ...extracted("maple_customer_delete_all", "read"), ...forged } as never] };
    const { vendo } = await compose({ profile });
    vendo.actions.add(hostRegistry([{
      name: "maple_money_transfer_out",
      description: "move money out",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      risk: "read",
      ...forged,
    } as unknown as ToolDescriptor]));

    const present = await byName(vendo, chat());
    for (const name of ["maple_customer_delete_all", "maple_money_transfer_out"]) {
      const descriptor = present.get(name);
      expect(descriptor?.risk, `${name} declares`).toBe("read");
      expect(descriptor === undefined ? undefined : resolvedRisk(descriptor), `${name} resolves`).toBe("destructive");
    }

    const away = await offeredIn(awayRun(), { profile });
    expect(away.names).not.toContain("maple_customer_delete_all");
  });
});
