/**
 * §12's SECOND MECHANICAL VOTE was ASYMMETRIC, and the asymmetry fell on reads.
 *
 * The destructive axis matches a verb ANYWHERE in the name (that is what moved
 * `maple_customer_delete_all` out of unattended runs). The read axis only ever
 * inspected the TRAILING token. So `verb_noun` — which is how essentially every
 * extracted host read is named — reached the fail-closed default and resolved
 * `write`. On the flagship demo that is `host_listAccounts`, `host_getAccount`,
 * `host_getProfile`, `host_listTransactions`: GET-bound reads, every one of them
 * voted `write`.
 *
 * Two things §12 says were false as a result:
 *  - "**Reads are silent, always**" — a `write` is a MUTATING call to everything
 *    downstream of `resolvedRisk`, so the guard wrote each of these an
 *    effect-ledger receipt on every call, and a re-run answered from the receipt
 *    instead of re-reading.
 *  - a host policy rule matching `{ risk: "write" }` would card a plain read.
 *
 * The fix is deliberately the NARROWEST symmetric one: a read verb anywhere
 * resolves `read` only when no destructive verb appears anywhere AND the binding
 * is not mutating. Both guards are asserted here, because a read-anywhere rule
 * without them would be the first thing in this file to LOWER a risk.
 *
 * Everything here reads a REAL `createVendo` over a REAL `.vendo/tools.json`
 * written to disk, because that file is where the bug lives: the names are the
 * extracted ones, and `bindingRisk` is DERIVED from the binding by the actions
 * registry rather than authored, so only the composed path shows what the vote
 * actually sees.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpMethod } from "@vendoai/actions";
import {
  descriptorHash,
  resolvedRisk,
  UNATTENDED_DESTRUCTIVE_REASON,
  type PermissionGrant,
  type Principal,
  type RunContext,
  type ToolDescriptor,
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

const principal: Principal = { kind: "user", subject: "user_readverb" };
const APP_ID = "app_readverb_1";
const HOST_ORIGIN = "http://127.0.0.1:59999";

const chat = (): RunContext => ({
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "s_readverb",
});

/** A real unattended firing, exactly as the automations engine assembles one. */
const awayRun = (): RunContext => ({
  principal,
  venue: "automation",
  presence: "away",
  sessionId: "sess_readverb_1",
  appId: APP_ID as never,
  trigger: { kind: "schedule", runId: "run_readverb_1" as never },
});

/**
 * One entry of `.vendo/tools.json`, in the shape the OpenAPI extractor emits for
 * the demo hosts — `bindingRisk` is nowhere in it, because the registry derives
 * that from `binding.method` and a host cannot author it.
 */
const extracted = (
  name: string,
  method: HttpMethod,
  risk: ToolDescriptor["risk"],
  path: string,
) => ({
  name,
  description: `host tool ${name}`,
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  risk,
  binding: {
    kind: "openapi" as const,
    operationId: name,
    baseUrl: HOST_ORIGIN,
    method,
    path,
  },
});

/**
 * The tools.json a Maple-shaped host ships. The first two names and bindings are
 * copied from `examples/demo-bank/.vendo/tools.json` verbatim — they are the observed
 * bug, not an invention.
 */
const TOOLS = [
  // THE BUG: `verb_noun`, GET-bound, declared `read` — and voted `write`.
  extracted("host_listAccounts", "GET", "read", "/api/accounts"),
  extracted("host_getProfile", "GET", "read", "/api/profile"),

  // Guard 1, the binding: the same read-shaped `verb_noun` name over a MUTATING
  // method. A read verb may never talk a mutating binding down.
  extracted("host_listInvoices", "POST", "read", "/api/invoices"),
  // The same guard at its sharpest: a read verb in front of a DELETE.
  extracted("host_getSnapshot", "DELETE", "read", "/api/snapshots"),
  // A DELETE whose name says nothing at all.
  extracted("host_recordTouch", "DELETE", "read", "/api/records"),

  // Guard 2, the vocabulary: a destructive verb anywhere still wins.
  extracted("host_transferMoney", "POST", "write", "/api/transfers"),
  extracted("maple_customer_delete_all", "GET", "read", "/api/customers"),

  // Guard 2 at its sharpest: a read verb and a destructive verb in ONE name.
  extracted("list_and_delete", "GET", "read", "/api/compound-a"),
  extracted("get_then_purge", "GET", "read", "/api/compound-b"),
  extracted("fetch_and_wire_funds", "GET", "read", "/api/compound-c"),
];

/** Every host call answers 200 with JSON, so an executed call is a real
 *  registry execution and its outcome is `ok` — which is what makes an EMPTY
 *  effect ledger evidence of silence rather than evidence of a refusal. */
const hostFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** An away run has no live session, so the registry refuses to dispatch one
 *  without this seam ("away execution isn't set up for this product"). Minting a
 *  bearer header is the smallest real one. */
const actAs = async () => ({ headers: { authorization: "Bearer away-token" } });

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-readverb-store-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** A REAL `.vendo/tools.json` on disk — the file read, not an in-memory piece. */
async function profileDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-readverb-host-"));
  await mkdir(join(root, ".vendo"), { recursive: true });
  await writeFile(
    join(root, ".vendo", "tools.json"),
    JSON.stringify({ format: "vendo/tools@3", tools: TOOLS }, null, 2),
    "utf8",
  );
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function compose(): Promise<{ vendo: Vendo; store: VendoStore }> {
  const store = await tempStore();
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    profileDir: await profileDir(),
    fetch: hostFetch,
    actAs,
  } as Parameters<typeof createVendo>[0]);
  await store.ensureSchema();
  return { vendo, store };
}

const composedByName = async (vendo: Vendo): Promise<Map<string, ToolDescriptor>> =>
  new Map((await vendo.guardedTools.descriptors(chat())).map((d) => [d.name, d]));

/** What the model is OFFERED in a run, read from inside a real harness turn —
 *  the public path that carries the run's ctx into `descriptors(ctx)`. */
async function offeredIn(ctx: RunContext): Promise<string[]> {
  const names: string[] = [];
  const store = await tempStore();
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    profileDir: await profileDir(),
    fetch: hostFetch,
    actAs,
    harness: defineHarness({
      name: "lister",
      async *run(turn) {
        for (const entry of await turn.tools.list()) names.push(entry.name);
        yield { type: "text", delta: "listed" };
      },
    }) as never,
  } as Parameters<typeof createVendo>[0]);
  await store.ensureSchema();
  const turn = await vendo.harness.stream({
    threadId: `thr_${ctx.presence}_${ctx.sessionId}`,
    message: { id: "m1", role: "user", parts: [{ type: "text", text: "go" }] } as never,
    ctx,
  });
  await turn.text();
  return names;
}

/** The authority an ENABLED automation carries: a standing, app-bound
 *  `source: "automation"` grant. Seeded so the pipeline says RUN and the call
 *  really executes — without it an empty effect ledger would only prove the
 *  guard parked the call. */
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

const effectRows = async (store: VendoStore): Promise<number> =>
  (await store.records("vendo_effects").list({})).records.length;

describe("a read verb ANYWHERE is a read (§12 'reads are silent, always')", () => {
  it("resolves the flagship demo's GET-bound verb_noun reads as READ, not write", async () => {
    const { vendo } = await compose();
    const composed = await composedByName(vendo);

    for (const name of ["host_listAccounts", "host_getProfile"]) {
      const descriptor = composed.get(name);
      expect(descriptor?.risk, `${name} declares`).toBe("read");
      expect(descriptor?.bindingRisk, `${name} is GET-bound`).toBeUndefined();
      expect(descriptor === undefined ? undefined : resolvedRisk(descriptor), `${name} resolves`)
        .toBe("read");
    }
  });

  it("offers them in an unattended run", async () => {
    const offered = await offeredIn(awayRun());

    expect(offered).toContain("host_listAccounts");
    expect(offered).toContain("host_getProfile");
  });

  it("takes NO effect-ledger row for them — the §12 property, asserted on the table", async () => {
    const { vendo, store } = await compose();
    const composed = await composedByName(vendo);
    for (const name of ["host_listAccounts", "host_getProfile"]) {
      await seedAwayGrant(store, composed.get(name) as ToolDescriptor);
    }

    const ctx = awayRun();
    const accounts = await vendo.guardedTools.execute(
      { id: "r_1", tool: "host_listAccounts", args: {} },
      ctx,
    );
    const profile = await vendo.guardedTools.execute(
      { id: "r_2", tool: "host_getProfile", args: {} },
      ctx,
    );

    // The calls really ran — so zero rows is silence, not a refusal.
    expect(accounts.status, JSON.stringify(accounts)).toBe("ok");
    expect(profile.status, JSON.stringify(profile)).toBe("ok");
    expect(await effectRows(store)).toBe(0);
  });

  it("still receipts a real WRITE in the same run, so the empty ledger above is meaningful", async () => {
    const { vendo, store } = await compose();
    const composed = await composedByName(vendo);
    const read = composed.get("host_listAccounts") as ToolDescriptor;
    const write = composed.get("host_listInvoices") as ToolDescriptor;
    await seedAwayGrant(store, read);
    await seedAwayGrant(store, write);

    const ctx = awayRun();
    expect((await vendo.guardedTools.execute({ id: "m_1", tool: "host_listAccounts", args: {} }, ctx)).status)
      .toBe("ok");
    expect((await vendo.guardedTools.execute({ id: "m_2", tool: "host_listInvoices", args: {} }, ctx)).status)
      .toBe("ok");

    // Exactly one row: the POST. The ledger is working; the read is silent.
    expect(await effectRows(store)).toBe(1);
  });
});

describe("the read-anywhere rule can never LOWER a risk", () => {
  it("keeps a POST-bound read-sounding verb_noun name a WRITE", async () => {
    // §12: "Automations may read and write". The name reads exactly like the
    // GET-bound tool above; only the method differs, and the method wins.
    const { vendo } = await compose();
    const descriptor = (await composedByName(vendo)).get("host_listInvoices");

    expect(descriptor?.bindingRisk, "POST derives write").toBe("write");
    expect(descriptor === undefined ? undefined : resolvedRisk(descriptor)).toBe("write");
    expect(await offeredIn(awayRun())).toContain("host_listInvoices");
  });

  it("keeps a DELETE destructive even with a read verb in the name", async () => {
    const { vendo } = await compose();
    const composed = await composedByName(vendo);

    for (const name of ["host_getSnapshot", "host_recordTouch"]) {
      const descriptor = composed.get(name);
      expect(descriptor?.risk, `${name} declares`).toBe("read");
      expect(descriptor === undefined ? undefined : resolvedRisk(descriptor), `${name} resolves`)
        .toBe("destructive");
    }

    const offered = await offeredIn(awayRun());
    expect(offered).not.toContain("host_getSnapshot");
    expect(offered).not.toContain("host_recordTouch");
  });

  it("keeps a destructive verb ANYWHERE destructive, trailing or not", async () => {
    const { vendo } = await compose();
    const composed = await composedByName(vendo);

    for (const name of ["host_transferMoney", "maple_customer_delete_all"]) {
      const descriptor = composed.get(name);
      expect(descriptor === undefined ? undefined : resolvedRisk(descriptor), `${name} resolves`)
        .toBe("destructive");
    }

    const offered = await offeredIn(awayRun());
    expect(offered).not.toContain("host_transferMoney");
    expect(offered).not.toContain("maple_customer_delete_all");
  });

  it("blocks the money mover at EXECUTE even holding a standing app-bound automation grant", async () => {
    const { vendo, store } = await compose();
    const descriptor = (await composedByName(vendo)).get("host_transferMoney") as ToolDescriptor;
    await seedAwayGrant(store, descriptor);

    const outcome = await vendo.guardedTools.execute(
      { id: "m_law", tool: "host_transferMoney", args: { amount: 2500, recipient_name: "Away Drill" } },
      awayRun(),
    );

    expect(outcome).toEqual({ status: "blocked", reason: UNATTENDED_DESTRUCTIVE_REASON });
    // Nothing executed, so nothing was receipted either.
    expect(await effectRows(store)).toBe(0);
  });

  it("resolves a compound name holding BOTH a read verb and a destructive verb as destructive", async () => {
    const { vendo } = await compose();
    const composed = await composedByName(vendo);

    for (const name of ["list_and_delete", "get_then_purge", "fetch_and_wire_funds"]) {
      const descriptor = composed.get(name);
      expect(descriptor?.risk, `${name} declares`).toBe("read");
      expect(descriptor === undefined ? undefined : resolvedRisk(descriptor), `${name} resolves`)
        .toBe("destructive");
    }

    const offered = await offeredIn(awayRun());
    for (const name of ["list_and_delete", "get_then_purge", "fetch_and_wire_funds"]) {
      expect(offered, `${name} is withheld`).not.toContain(name);
    }
  });
});
