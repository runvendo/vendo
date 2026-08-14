/**
 * The T1/D3 workspace seam, with no stand-in on either side: the REAL
 * `workspaceStore` façade over a REAL `hostedStore`, against the REAL Vendo
 * Cloud console — written through one client and read back through a second,
 * freshly constructed one, so the only thing that can make it pass is the
 * console genuinely holding the files.
 *
 * What it proves, in order: the façade works at all over the wire; two owners
 * of the SAME deployment do not see each other's files (the hole the console's
 * per-request `owner` closes); a delete actually deletes; and erasing one
 * subject takes their whole drawer with it and leaves the other's.
 *
 * Gated on `VENDO_API_KEY` having content, like every other `.live.test.ts`:
 * skipped without it, so CI and a keyless clone stay green. `VENDO_CLOUD_URL`
 * overrides the mount for a staging console. Every id is per-run unique so two
 * runs never collide, and everything written is erased at the end.
 */
import type { Principal } from "@vendoai/core";
import { hostedStore, workspaceStore, type HostedStore } from "@vendoai/store";
import { afterAll, describe, expect, it } from "vitest";

// A named secret can EXIST and be empty (`infisical secrets get` exits 0 either
// way), so the gate checks for content rather than for presence.
const apiKey = process.env["VENDO_API_KEY"] ?? "";
const live = apiKey === "" ? describe.skip : describe;

const LIVE_TIMEOUT_MS = 60_000;

const run = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const mine: Principal = { kind: "user", subject: `user_ws_${run}` };
const theirs: Principal = { kind: "user", subject: `user_ws_other_${run}` };
const PATH = "/user/notes/plan.md";

const client = (): HostedStore => hostedStore({
  apiKey,
  ...(process.env["VENDO_CLOUD_URL"] === undefined ? {} : { baseUrl: process.env["VENDO_CLOUD_URL"] }),
});

/** The shipped façade, picking the ops backend off the hosted store because
    there is no SQL handle to pick. */
const workspace = (store: HostedStore = client()) => workspaceStore(store);

live("hosted workspace over the real console", () => {
  const writer = client();

  afterAll(async () => {
    for (const subject of [mine.subject, theirs.subject]) {
      await writer.ops.lifecycle.erase({ subject }).catch(() => undefined);
    }
  }, LIVE_TIMEOUT_MS);

  it("commits a file through the façade and reads it back on a fresh client", async () => {
    const turn = await workspace(writer).open(mine);
    await turn.writeFile(PATH, "the plan");
    expect(await turn.commit({ message: "planned" })).toEqual({ status: "ok", changed: [PATH] });

    // A client constructed after the write, sharing nothing with the writer but
    // the account.
    const next = await workspace().open(mine);
    expect(await next.readFile(PATH)).toBe("the plan");
    expect(next.getAllPaths()).toContain(PATH);
  }, LIVE_TIMEOUT_MS);

  it("keeps another user of the same deployment out of that file", async () => {
    const stranger = await workspace().open(theirs);
    // Not "forbidden" — absent. The path is not in their drawer at all.
    expect(await stranger.exists(PATH)).toBe(false);

    // And their own file at the SAME path is their own.
    await stranger.writeFile(PATH, "someone else's plan");
    expect(await stranger.commit()).toEqual({ status: "ok", changed: [PATH] });
    expect(await (await workspace().open(theirs)).readFile(PATH)).toBe("someone else's plan");
    expect(await (await workspace().open(mine)).readFile(PATH)).toBe("the plan");
  }, LIVE_TIMEOUT_MS);

  it("removes a file, and a fresh client agrees it is gone", async () => {
    const doomed = "/user/notes/scratchpad.md";
    const first = await workspace().open(mine);
    await first.writeFile(doomed, "temporary");
    await first.commit();
    expect(await (await workspace().open(mine)).readFile(doomed)).toBe("temporary");

    const cleaner = await workspace().open(mine);
    await cleaner.rm(doomed);
    expect(await cleaner.commit()).toEqual({ status: "ok", changed: [doomed] });
    expect(await (await workspace().open(mine)).exists(doomed)).toBe(false);
    // The file that was not deleted is still there.
    expect(await (await workspace().open(mine)).readFile(PATH)).toBe("the plan");
  }, LIVE_TIMEOUT_MS);

  it("erases one subject's whole drawer and leaves the other's", async () => {
    await writer.ops.lifecycle.erase({ subject: mine.subject });

    expect((await workspace().open(mine)).getAllPaths()).toEqual([]);
    expect(await (await workspace().open(theirs)).readFile(PATH)).toBe("someone else's plan");
  }, LIVE_TIMEOUT_MS);
});
