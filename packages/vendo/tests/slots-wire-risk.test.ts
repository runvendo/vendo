// RISK ROUND — what POST /slots accepts, and what nothing ever collects.
//
// The registry is written by ANY page render, so this route is the widest
// unprivileged write surface the apps block has: one request, one row per
// entry, no ceiling. Every sibling on this wire bounds its input —
// `readBoundedJson(request, ROW_MAX_BYTES)` at 256 KiB plus a 1–256 character
// id on the /box rows surface (wire/box.ts:29,146,219), at most 200 tool names
// on /doctor (wire/misc.ts:153) — and this route bounds nothing: `requestJson`
// reads the whole body, `descriptor` checks each entry's SHAPE and never its
// size, and the array's length is never looked at (wire/slots.ts:16-34).
//
// The cases below are written against that house discipline, not against a
// number this round invented: what they pin is that SOME ceiling exists and
// answers `validation`, the way every neighbouring write surface does. The
// exact cap is a spec decision.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { createStore, eraseStore, storeFiles, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

const principal: Principal = { kind: "user", subject: "user_slots" };
/** The host has no signed-in person for this visitor — the shape a marketing
 *  page or a signed-out app resolves (examples/demo-bank/src/vendo/server.ts). */
const visitor: Principal = { kind: "user", subject: "visitor_1", ephemeral: true };

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-slots-risk-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const request = (method: string, path: string, body?: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("POST /slots bounds its input like every other write on this wire", () => {
  it("refuses a report with an implausible number of entries", async () => {
    const store = await tempStore();
    const vendo = createVendo({ principal: async () => principal, store });

    // No page mounts ten thousand slots. One request writes ten thousand rows.
    const flood = Array.from({ length: 10_000 }, (_, index) => ({
      id: `slot_${index}`,
      label: `Slot ${index}`,
    }));
    const response = await vendo.handler(request("POST", "/slots", { slots: flood }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation" } });

    // ...and nothing is written on the way to the refusal.
    expect(await (await vendo.handler(request("GET", "/slots"))).json()).toEqual([]);
  }, 120_000);

  it("refuses a slot descriptor far larger than any id or label a page carries", async () => {
    const store = await tempStore();
    const vendo = createVendo({ principal: async () => principal, store });

    // A megabyte in ONE label — four times the /box row ceiling, stored verbatim
    // in a row the registry read hands back to every picker that opens.
    const response = await vendo.handler(request("POST", "/slots", {
      slots: [{ id: "hero", label: "x".repeat(1024 * 1024) }],
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation" } });
  }, 60_000);

  it("bounds an anonymous visitor's writes the same way", async () => {
    // Nothing on this route distinguishes a signed-in person from a visitor the
    // host resolved to a throwaway subject, so the ceiling is the only thing
    // between an open page and unbounded rows. `/connections` (connections.ts:54)
    // and the MCP door (packages/mcp/src/door.ts:520) both refuse an ephemeral
    // principal outright; whether this surface should too is a spec decision —
    // this case only asks that SOMETHING bound it.
    const store = await tempStore();
    const vendo = createVendo({ principal: async () => visitor, store });

    const flood = Array.from({ length: 10_000 }, (_, index) => ({
      id: `slot_${index}`,
      label: `Slot ${index}`,
    }));
    const response = await vendo.handler(request("POST", "/slots", { slots: flood }));
    expect(response.status).toBe(400);
  }, 120_000);
});

describe("the slot registry's decay collects the row, not just the answer", () => {
  it("leaves no row behind for a slot nobody has rendered in months", async () => {
    // slots.ts:6-9 — "a slot that stopped rendering ages out of the registry on
    // its own after SLOT_DECAY_MS". The READ ages out (the `lastSeen` filter in
    // `list`); the ROW never does. Nothing in the composition collects it: the
    // TTL sweep has exactly two legs, parked BYO calls and stranded approvals
    // (compose-sweep.ts:15,22), and neither reaches `vendo_records`.
    //
    // So every subject that ever rendered a page keeps its slot rows forever,
    // including the throwaway subjects a signed-out host resolves per visitor,
    // and the only thing that ever removes one is a full `erase.bySubject`.
    // WHERE the collection belongs — a sweep leg, a write-time compaction, or a
    // decision that rows are kept on purpose — is a spec decision; this case
    // only pins that the registry does not grow without bound.
    const store = await tempStore();
    const vendo = createVendo({ principal: async () => principal, store });

    await vendo.handler(request("POST", "/slots", { slots: [{ id: "retired", label: "Retired" }] }));

    // Age the row past the decay window by hand — the wire stamps `lastSeen`
    // server-side (slots.ts:70), which is exactly why a client cannot do this.
    const rows = store.records("vendo_slots");
    const stored = (await rows.list({ refs: { subject: principal.subject } })).records;
    expect(stored).toHaveLength(1);
    await rows.put({
      id: stored[0]!.id,
      data: { id: "retired", label: "Retired", lastSeen: "2020-01-01T00:00:00.000Z" },
      refs: { subject: principal.subject },
    });

    // The read already agrees the slot is gone.
    expect(await (await vendo.handler(request("GET", "/slots"))).json()).toEqual([]);

    // Give the composition every chance to collect it: the authenticated tick
    // drives the sweep, and an ordinary request runs the amortized pass.
    await vendo.handler(request("GET", "/slots"));

    expect((await rows.list({ refs: { subject: principal.subject } })).records).toEqual([]);
  }, 60_000);
});

describe("axes that hold (regression cover, not findings)", () => {
  it("keeps two subjects apart under ':' and '%' in the subject and the slot id", async () => {
    // `rowId` percent-encodes both halves (slots.ts:51), and `encodeURIComponent`
    // escapes ':' as %3A and '%' as %25 — so the pair cannot be shifted, and the
    // read is scoped by `refs.subject` regardless (slots.ts:82).
    const store = await tempStore();
    const shift = async (subject: string, slot: { id: string; label: string }) => {
      const vendo = createVendo({ principal: async () => ({ kind: "user", subject }), store });
      await vendo.handler(request("POST", "/slots", { slots: [slot] }));
      return async () => (await (await vendo.handler(request("GET", "/slots"))).json()) as
        { id: string; label: string }[];
    };

    const victim = await shift("a:b", { id: "c", label: "Victim" });
    const attacker = await shift("a", { id: "b:c", label: "Attacker" });
    const encoded = await shift("a", { id: "b%3Ac", label: "Pre-encoded" });

    expect(await victim()).toMatchObject([{ id: "c", label: "Victim" }]);
    expect((await attacker()).map(row => row.label).sort()).toEqual(["Attacker", "Pre-encoded"]);
    expect((await encoded()).map(row => row.id).sort()).toEqual(["b%3Ac", "b:c"]);
  }, 60_000);

  it("takes the subject's slot rows with the erase cascade", async () => {
    const store = await tempStore();
    const vendo = createVendo({ principal: async () => principal, store });
    await vendo.handler(request("POST", "/slots", { slots: [{ id: "hero", label: "Hero" }] }));

    const report = await eraseStore(store, { files: storeFiles(store) }).bySubject(principal.subject);
    expect(report.vendo_records).toBe(1);
    expect(await (await vendo.handler(request("GET", "/slots"))).json()).toEqual([]);
  }, 60_000);
});
