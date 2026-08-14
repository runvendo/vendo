/**
 * D3 said hosted workspace is "indistinguishable from local, no asterisks".
 * The `/orgs` mounts' commit policy (build contract §9.7) is strict
 * compare-and-swap: a write built on a base that is no longer the head must come
 * back `conflict`, never overwrite a colleague. The SQL backend enforces that
 * for a CREATE too — `landRow` compares `prepared.prior?.revision ?? null`
 * against the caller's checkout base, and a file that appeared under a caller
 * who checked out nothing is a lost swap (`workspace-rows.ts` ~line 341).
 *
 * The hosted backend drops the guarantee for exactly that case:
 *
 *   workspace-ops-rows.ts `land`:
 *     const strict = options?.strict === true
 *       && typeof options.expectedRevision === "number";
 *
 * `WorkspaceStoreFs.commit` passes `expectedRevision: index.get(path)?.revision
 * ?? null` — and for a path the caller never checked out that is `null`, not a
 * number. So `strict` is false, the entry goes over the wire with no
 * `expectedRevision`, and the console's unguarded `files.put` silently
 * overwrites the colleague's file.
 *
 * Written as the deterministic form of the race (second writer opens a FRESH
 * façade, so their index genuinely has no entry for the path) so it needs no
 * timing to reproduce. Local (`postgres`) answers `conflict` here.
 *
 * Gated on `VENDO_API_KEY` like every other `.live.test.ts`.
 */
import type { Membership, Principal } from "@vendoai/core";
import { hostedStore, workspaceStore, type HostedStore } from "@vendoai/store";
import { afterAll, describe, expect, it } from "vitest";

const apiKey = process.env["VENDO_API_KEY"] ?? "";
const live = apiKey === "" ? describe.skip : describe;

const LIVE_TIMEOUT_MS = 60_000;

const run = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const org = `org_cas_${run}`;
const memberships: Membership[] = [{ org }];
const alice: Principal = { kind: "user", subject: `user_cas_a_${run}` };
const bob: Principal = { kind: "user", subject: `user_cas_b_${run}` };
const PATH = `/orgs/${org}/shared/plan.md`;

const client = (): HostedStore => hostedStore({
  apiKey,
  ...(process.env["VENDO_CLOUD_URL"] === undefined ? {} : { baseUrl: process.env["VENDO_CLOUD_URL"] }),
});

const open = async (principal: Principal) =>
  await workspaceStore(client()).open(principal, { memberships });

live("hosted /orgs commits keep the strict-CAS guarantee", () => {
  afterAll(async () => {
    const writer = client();
    for (const subject of [alice.subject, bob.subject, org]) {
      await writer.ops.lifecycle.erase({ subject }).catch(() => undefined);
    }
  }, LIVE_TIMEOUT_MS);

  it("refuses a create that would overwrite a colleague's file it never checked out", async () => {
    // BOTH turns open before either commits — the ordinary shape of two
    // colleagues starting work on the same org file. Bob's index therefore
    // carries no base for the path, which is the state the guard has to catch.
    const first = await open(alice);
    const second = await open(bob);
    expect(second.getAllPaths()).not.toContain(PATH);

    await first.writeFile(PATH, "alice's plan");
    expect(await first.commit({ message: "alice" })).toEqual({ status: "ok", changed: [PATH] });

    await second.writeFile(PATH, "bob's plan");
    expect(await second.commit({ message: "bob" })).toEqual({ status: "conflict", paths: [PATH] });

    // And nothing of alice's was destroyed.
    expect(await (await open(alice)).readFile(PATH)).toBe("alice's plan");
  }, LIVE_TIMEOUT_MS);
});
