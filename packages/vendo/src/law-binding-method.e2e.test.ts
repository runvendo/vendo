/**
 * §12's SECOND MECHANICAL VOTE has two axes — "HTTP method + verb shape" — and
 * the METHOD axis was dead in production.
 *
 * `mechanicalRisk` reads the method off the descriptor, but the descriptor a
 * host-extracted tool reaches the guard as is minted by `descriptorOf` in the
 * actions registry, a field WHITELIST that dropped `binding.method`. So exactly
 * half the vote never fired, precisely on the tools the vote exists for:
 * extracted host tools are the AI-ASSIGNED labels (contract §8, 2026-07-31),
 * and a DELETE-bound tool an extractor or an override called `write` was
 * projected into unattended runs.
 *
 * Everything here reads a REAL `createVendo` over a REAL `.vendo/tools.json`
 * profile, because a hand-built descriptor cannot reproduce the bug: it carries
 * a method the whitelist would have dropped. The offered toolset is read through
 * a real harness turn — `turn.tools.list()` is the "what is the model even
 * shown" door, which is where THE LAW's primary mechanism lives.
 */
import { mkdtemp, rm } from "node:fs/promises";
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

const principal: Principal = { kind: "user", subject: "user_method" };
const APP_ID = "app_method_1";

const chat = (): RunContext => ({
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "s_method",
});

/** A real unattended firing, exactly as the automations engine assembles one. */
const awayRun = (): RunContext => ({
  principal,
  venue: "automation",
  presence: "away",
  sessionId: "sess_method_1",
  appId: APP_ID as never,
  trigger: { kind: "schedule", runId: "run_method_1" as never },
});

/**
 * One entry of `.vendo/tools.json`: a descriptor plus the execution binding the
 * method axis is supposed to read. Every fixture here declares the LEAST
 * destructive label its shape could plausibly carry, so the mechanical vote is
 * the only thing that can reach the right answer.
 */
const routeTool = (
  name: string,
  method: HttpMethod,
  risk: ToolDescriptor["risk"],
) => ({
  name,
  description: `host tool ${name}`,
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  risk,
  binding: { kind: "route" as const, method, path: `/api/${name}`, argsIn: "query" as const },
});

/** The tools.json a Maple-shaped host would ship. Names chosen to read HARMLESS
 *  — the point is that the method, not the name, is what convicts them. */
const PROFILE = {
  tools: [
    // The named case: a DELETE bound to a name that reads like an edit.
    routeTool("maple_thing_update", "DELETE", "write"),
    routeTool("maple_record_touch", "DELETE", "write"),
    // The control on the other side of the same axis: same shape, read binding.
    routeTool("maple_thing_get", "GET", "read"),
    routeTool("maple_note_touch", "PATCH", "write"),
    // A mutating method must not let a read-shaped NAME launder a destructive
    // verb: `_list` short-circuits to `read` on its own, so before the method
    // reached the vote this was offered to every automation.
    routeTool("maple_records_purge_list", "POST", "read"),
    // A host must not be able to LOWER a risk with a permissive method.
    routeTool("maple_account_delete", "GET", "read"),
  ],
};

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-method-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

async function compose(): Promise<{ vendo: Vendo; store: VendoStore }> {
  const store = await tempStore();
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    profile: PROFILE as never,
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
    profile: PROFILE as never,
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
    threadId: `thr_${ctx.presence}`,
    message: { id: "m1", role: "user", parts: [{ type: "text", text: "go" }] } as never,
    ctx,
  });
  await turn.text();
  return names;
}

/** The authority an ENABLED automation carries: a standing, app-bound
 *  `source: "automation"` grant. THE LAW must beat it. */
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

describe("the METHOD axis fires on host-EXTRACTED tools (design §12)", () => {
  it("resolves a DELETE-bound tool destructive however harmless its name reads", async () => {
    const { vendo } = await compose();
    const composed = await composedByName(vendo);

    for (const name of ["maple_thing_update", "maple_record_touch"]) {
      const descriptor = composed.get(name);
      expect(descriptor?.risk, `${name} declares`).toBe("write");
      expect(descriptor === undefined ? undefined : resolvedRisk(descriptor), `${name} resolves`)
        .toBe("destructive");
    }
  });

  it("withholds it from an unattended run — the model is never even offered it", async () => {
    const offered = await offeredIn(awayRun());

    expect(offered).not.toContain("maple_thing_update");
    expect(offered).not.toContain("maple_record_touch");
    // The control: the same run still sees the host tools the law permits, so
    // this is withholding and not an empty toolset.
    expect(offered).toContain("maple_thing_get");
  });

  it("blocks it at execute even holding a standing app-bound automation grant", async () => {
    const { vendo, store } = await compose();
    const descriptor = (await composedByName(vendo)).get("maple_thing_update") as ToolDescriptor;
    await seedAwayGrant(store, descriptor);

    const outcome = await vendo.guardedTools.execute(
      { id: "m_1", tool: "maple_thing_update", args: { id: "thg_1" } },
      awayRun(),
    );

    expect(outcome).toEqual({ status: "blocked", reason: UNATTENDED_DESTRUCTIVE_REASON });
  });

  it("does not sweep READS into destructive: a GET-bound read stays read and stays offered", async () => {
    const { vendo } = await compose();
    const descriptor = (await composedByName(vendo)).get("maple_thing_get");

    expect(descriptor === undefined ? undefined : resolvedRisk(descriptor)).toBe("read");
    expect(await offeredIn(awayRun())).toContain("maple_thing_get");
  });

  it("keeps a plainly mutating method a WRITE — automations may still read and write", async () => {
    // §12 verbatim: "Automations may read and write". A PATCH is a write, so it
    // must escalate a read-shaped name to `write` and stop there — treating
    // every mutating method as destructive would withhold the entire write half
    // of the estate from automations and break the law's own prepare path.
    const { vendo } = await compose();
    const descriptor = (await composedByName(vendo)).get("maple_note_touch");

    expect(descriptor === undefined ? undefined : resolvedRisk(descriptor)).toBe("write");
    expect(await offeredIn(awayRun())).toContain("maple_note_touch");
  });

  it("stops a mutating method from laundering a destructive verb behind a read-shaped name", async () => {
    // `_list` is a trailing read verb, so the name alone short-circuits to
    // `read` and the destructive scan never runs. The method is the only thing
    // that can convict this tool — and it was being dropped.
    const { vendo } = await compose();
    const descriptor = (await composedByName(vendo)).get("maple_records_purge_list");

    expect(descriptor?.risk, "declares").toBe("read");
    expect(descriptor === undefined ? undefined : resolvedRisk(descriptor)).toBe("destructive");
    expect(await offeredIn(awayRun())).not.toContain("maple_records_purge_list");
  });

  it("cannot be used to LOWER a risk: a permissive method never rescues a destructive name", async () => {
    const { vendo } = await compose();
    const descriptor = (await composedByName(vendo)).get("maple_account_delete");

    expect(descriptor === undefined ? undefined : resolvedRisk(descriptor)).toBe("destructive");
    expect(await offeredIn(awayRun())).not.toContain("maple_account_delete");
  });
});
