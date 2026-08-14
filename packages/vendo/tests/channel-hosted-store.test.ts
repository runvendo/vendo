import type { ApprovalId } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { ChannelAskRepository, ChannelEventLog, ChannelLinkRepository } from "../src/channel-links.js";
import { hostedStore } from "../src/hosted-store.js";
import { fakeConsole } from "../src/hosted-store.test-util.js";

/**
 * The channel's rows against the HOSTED door — the seam that actually ships.
 *
 * WHY THIS FILE EXISTS: every other channel test composes a local store, and a
 * local store has no engine allowlist in front of it. The hosted door does
 * (`engine-collections.ts`), and a Cloud host leaves the store slot unset, so
 * hosted is the posture the feature runs in. The channel shipped with its three
 * collections missing from that list: the suite was green, and the first write on
 * the live deployment answered
 *   403 collection "vendo_channel_links" is not an engine collection
 * which made link, status, unlink and every inbound text dead on arrival.
 *
 * So these cases exercise the repositories through `hostedStore`, whose fake
 * console serves the same gate the live door serves — deliberately, per the note
 * at `hosted-store.test-util.ts`: a fake that answers a collection the real door
 * refuses lets a wrong call pass every test and fail in production. Add a
 * collection to this feature and it must appear both in `channel-links.ts` and in
 * `ENGINE_COLLECTIONS`, or this file goes red.
 */

const hosted = () => hostedStore({
  apiKey: "vnd_secret",
  baseUrl: "https://cloud.test",
  fetch: fakeConsole().handler as unknown as typeof fetch,
});

const APPROVAL = "apr_33333333-3333-3333-3333-333333333333" as ApprovalId;

describe("the text channel on a Cloud-hosted store", () => {
  it("mints and claims a link through the engine door", async () => {
    const links = new ChannelLinkRepository(hosted());

    const minted = await links.mint("user_hosted");
    expect(minted.code).toMatch(/^[23456789A-Z]{6}$/);

    const claimed = await links.claim(minted.code!, "+15557770123");
    expect(claimed?.subject).toBe("user_hosted");
    // Read back through the door the inbound text uses.
    expect((await links.byPhone("+15557770123"))?.subject).toBe("user_hosted");
    expect((await links.bySubject("user_hosted"))?.phone).toBe("+15557770123");

    await links.unlink("user_hosted");
    expect(await links.byPhone("+15557770123")).toBeNull();
  });

  it("records and spends an answerable card through the engine door", async () => {
    const asks = new ChannelAskRepository(hosted());

    await asks.add("user_hosted", "conv_hosted", APPROVAL);
    expect(await asks.ids("conv_hosted")).toEqual([APPROVAL]);

    await asks.consume(APPROVAL);
    expect(await asks.ids("conv_hosted")).toEqual([]);
  });

  it("claims a delivery through the engine door", async () => {
    const log = new ChannelEventLog(hosted());

    expect(await log.claim("evt_hosted", "conv_hosted")).toBe(true);
    expect(await log.claim("evt_hosted", "conv_hosted")).toBe(false);
  });
});
