/**
 * The T1 seam, with no stand-in on either side: the REAL transcript and
 * harness-state helpers, over a REAL `hostedStore`, against the REAL Vendo Cloud
 * console — written through one client and read back through a second, freshly
 * constructed one.
 *
 * Why a second client: a harness that mocks the counterparty proves nothing, and
 * so does one that reads its own process's memory back. The read here goes over
 * the wire a second time, from a client that has never seen the write, so the
 * only thing that can make it pass is the console genuinely holding the rows.
 *
 * Gated on `VENDO_API_KEY` having content, like every other `.live.test.ts`:
 * skipped without it, so CI and a keyless clone stay green. `VENDO_CLOUD_URL`
 * overrides the mount for a staging console. Everything written is deleted at
 * the end, and every id is per-run unique so two runs never collide.
 */
import { VendoError, type Principal } from "@vendoai/core";
import { harnessStateStore, threadMessageStore } from "@vendoai/store";
import type { UIMessage } from "ai";
import { afterAll, describe, expect, it } from "vitest";
import { hostedStore, type HostedStore } from "./hosted-store.js";

// A named secret can EXIST and be empty (`infisical secrets get` exits 0 either
// way), so the gate checks for content rather than for presence.
const apiKey = process.env["VENDO_API_KEY"] ?? "";
const live = apiKey === "" ? describe.skip : describe;

const LIVE_TIMEOUT_MS = 60_000;

/** Every run gets its own thread and its own subjects — the console account is
 *  Yousef's real one, shared with every other live test. */
const run = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const threadId = `thr_live_${run}`;
const owner: Principal = { kind: "user", subject: `user_live_${run}` };
const stranger: Principal = { kind: "user", subject: `user_other_${run}` };

const client = (): HostedStore => hostedStore({
  apiKey,
  ...(process.env["VENDO_CLOUD_URL"] === undefined ? {} : { baseUrl: process.env["VENDO_CLOUD_URL"] }),
});

const message = (id: string, text: string, role: "user" | "assistant" = "user"): UIMessage =>
  ({ id, role, parts: [{ type: "text", text }] }) as UIMessage;

const textOf = (m: UIMessage | undefined): string =>
  (m?.parts ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

live("hosted transcript + harness state over the real console", () => {
  // ONE writer for the whole file; every read builds its own reader.
  const writer = client();

  afterAll(async () => {
    await writer.ops.transcripts.deleteThread(threadId).catch(() => undefined);
  }, LIVE_TIMEOUT_MS);

  it("writes a transcript through the helper and reads it back on a fresh client", async () => {
    await writer.ops.transcripts.putThread({ id: threadId, subject: owner.subject, messages: [] });

    // The producer: the SHIPPED helper, picking the ops backend off the hosted
    // store because there is no SQL handle to pick.
    const producer = threadMessageStore<UIMessage>(writer);
    await producer.upsert(owner, threadId, message("m_1", "what do I owe?"), 0);
    await producer.upsert(owner, threadId, message("m_2", "checking now", "assistant"), 1);

    // The consumer: the same shipped helper, over a client constructed after the
    // write and sharing nothing with the writer but the account.
    const consumer = threadMessageStore<UIMessage>(client());
    const listed = await consumer.list(owner, threadId);

    expect(listed.map((m) => m.id)).toEqual(["m_1", "m_2"]);
    expect(textOf(listed[0])).toBe("what do I owe?");
    expect(textOf(listed[1])).toBe("checking now");
  }, LIVE_TIMEOUT_MS);

  /**
   * KNOWN CONSOLE GAP, recorded as an executable fact rather than a comment:
   * `it.fails` passes while the console is wrong and turns RED the moment it is
   * fixed, so nobody has to remember to come back.
   *
   * Design D2 reads `transcripts.putMessage` as "insert OR edit-by-id", which is
   * what the local backend does (`packages/store/src/ops.ts`: append, and on an
   * id collision UPDATE that row). The live console instead appends into the
   * thread's message array and re-puts the whole thread, so re-writing a message
   * under its own id is refused with
   *   `thread … carries two messages with the id "m_2"; message ids must be
   *    unique within a thread`.
   *
   * That is the approval flip: when an approval resolves, the runtime re-writes
   * the already persisted assistant message under its own id. Until the console
   * makes `putMessage` replace-by-id, a hosted deployment fails that write —
   * loudly, at least, not silently duplicating history. The fix is console-side;
   * there is no wire op that expresses an edit any other way.
   */
  it.fails("an approval flip edits the message in place — one copy, not two", async () => {
    await threadMessageStore<UIMessage>(writer)
      .upsert(owner, threadId, message("m_2", "approved: you owe $40", "assistant"), 1);

    const listed = await threadMessageStore<UIMessage>(client()).list(owner, threadId);

    expect(listed.map((m) => m.id)).toEqual(["m_1", "m_2"]);
    expect(textOf(listed[1])).toBe("approved: you owe $40");
  }, LIVE_TIMEOUT_MS);

  it("another subject reads the thread as empty and cannot write to it", async () => {
    const foreign = threadMessageStore<UIMessage>(client());

    await expect(foreign.list(stranger, threadId)).resolves.toEqual([]);
    await expect(foreign.upsert(stranger, threadId, message("m_x", "mine now"), 2))
      .rejects.toBeInstanceOf(VendoError);
    // And the owner's transcript is untouched by the attempt.
    await expect(threadMessageStore<UIMessage>(client()).list(owner, threadId)).resolves.toHaveLength(2);
  }, LIVE_TIMEOUT_MS);

  it("keeps a harness's native session across clients, and destroys it on a swap", async () => {
    await harnessStateStore(writer).set(threadId, "claude-code", `sess_${run}`);

    expect(await harnessStateStore(client()).get(threadId, "claude-code")).toBe(`sess_${run}`);
    // §1.3: a different thinker holds this conversation now, so the slot is
    // destroyed rather than shadowed — swapping back must not resurrect it.
    expect(await harnessStateStore(client()).get(threadId, "vendo")).toBeUndefined();
    expect(await harnessStateStore(client()).get(threadId, "claude-code")).toBeUndefined();
  }, LIVE_TIMEOUT_MS);
});
