// RISK ROUND — what POST /slots accepts, and what nothing ever collects.
//
// The registry is written by ANY page render, so this route is the widest
// unprivileged write surface the apps block has: one request, one row per
// entry. It used to bound nothing — `descriptor` checked each entry's SHAPE
// and never its size, and the array's length was never looked at — while every
// sibling on this wire bounds its input: `readBoundedJson(request,
// ROW_MAX_BYTES)` at 256 KiB plus a 1–256 character id on the /box rows
// surface (wire/box.ts:29,146,219), at most 200 tool names on /sync/impact
// (wire/misc.ts:153).
//
// It now carries the same house discipline: at most 200 entries per report,
// each id and label 1–256 characters (wire/slots.ts). The cases below pin that
// a ceiling exists and answers `validation`, not the particular numbers.
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

describe("the slot registry's decay is a read filter, and the row is kept", () => {
  it("stops answering with an aged-out slot while its row stays put", async () => {
    // Spec decision: the ROW is kept on purpose. Decay is the `lastSeen` filter
    // in `list` and nothing else — no sweep leg reaches `vendo_records`
    // (compose-sweep.ts has exactly two, parked BYO calls and stranded
    // approvals). The registry is one row per (subject, slot), refreshed in
    // place rather than appended, so a subject's rows are bounded by the slots
    // it has actually rendered; `erase.bySubject` is what removes them (below).
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

    // The read no longer offers it as a destination...
    expect(await (await vendo.handler(request("GET", "/slots"))).json()).toEqual([]);

    // ...and a further request — which runs the amortized sweep pass — leaves
    // the row exactly where it was, so the slot revives the day a page mounts
    // it again instead of being silently forgotten.
    await vendo.handler(request("GET", "/slots"));

    const kept = (await rows.list({ refs: { subject: principal.subject } })).records;
    expect(kept).toHaveLength(1);
    expect(kept[0]!.data).toMatchObject({ id: "retired", lastSeen: "2020-01-01T00:00:00.000Z" });
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
