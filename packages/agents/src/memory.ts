/**
 * Per-user memory: the adapter, the store-backed default, and the one tool that
 * writes it.
 *
 * READS ARE AUTOMATIC, WRITES ARE DELIBERATE — the whole shape of the feature.
 * `recall` rides the per-turn prompt as a capped `[Memory]` block, so the model
 * never asks for what it was already told; nothing is ever inferred from a
 * transcript, because the only way a memory comes into being is the `remember`
 * tool below, which is listed, described, audited and guard-checked like every
 * other call.
 *
 * EVERY verb takes the principal it acts for and scopes on `principal.subject`.
 * The generic records door keys rows on (collection, id) alone
 * (`packages/store/src/records.ts:90-101`), so per-user isolation is this
 * module's to enforce: `refs.subject` is written on every row and filtered on
 * every read, the delete reads through that same filter before it removes
 * anything, and no verb — the tool least of all — takes a subject from its
 * caller's input.
 */
import { VendoError, type Principal, type VendoRecord } from "@vendoai/core";
import type { VendoStore } from "@vendoai/store";
import { randomUUID } from "node:crypto";
import { tool, type HostTool } from "./tools.js";

/** One remembered fact. `at` is when it was first written — a listing shows it,
 *  the prompt does not. */
export interface Memory {
  id: string;
  text: string;
  at: string;
}

/**
 * The BYO seam: five verbs, one subject axis. An adapter passed to
 * `agent({ memory })` is used verbatim, so a host that already knows its users'
 * preferences can answer `recall` from its own tables — the standard ladder,
 * where `memory: true` is only the rung this package ships.
 */
export interface MemoryAdapter {
  /** The `limit` most recent, OLDEST FIRST: the order they read in, and the
   *  order that makes a cap drop the stalest fact rather than the newest one. */
  recall(principal: Principal, limit: number): Promise<readonly Memory[]>;
  remember(principal: Principal, text: string): Promise<Memory>;
  /** Everything this subject remembers, newest first — a settings list, not a
   *  prompt, so it is complete and uncapped. */
  list(principal: Principal): Promise<readonly Memory[]>;
  delete(principal: Principal, id: string): Promise<void>;
  clear(principal: Principal): Promise<void>;
}

/**
 * How many memories a TURN READS. A prompt budget, not a storage limit: the
 * store keeps every memory a person ever made and `list` still returns them
 * all — this is only how many of the most recent ride in `[Memory]`, so someone
 * who has remembered a hundred things does not spend a hundred facts of every
 * later turn on them. Twenty is the point past which the oldest fact has
 * stopped describing the person and become history — app memory's own number,
 * for its own reason (`APP_MEMORY_MAX_ASKS`).
 */
export const MEMORY_RECALL_LIMIT = 20;

/**
 * How much of ONE memory is kept. A fact about a person is a sentence; the cap
 * exists because a model that ignores "keep it short" would otherwise put a
 * transcript into every future prompt (`APP_MEMORY_DECISIONS_MAX_BYTES`'s
 * reason). Counted in CODE POINTS, so a cut never splits a surrogate pair into
 * a lone half no jsonb column will accept.
 */
export const MEMORY_TEXT_MAX_CHARS = 500;

const COLLECTION = "vendo_memories";

const memoryFromRecord = (record: VendoRecord): Memory => {
  const { text } = record.data as { text?: unknown };
  return { id: record.id, text: typeof text === "string" ? text : "", at: record.createdAt };
};

/**
 * The default: this composition's own store, in the generic `vendo_records`
 * table — no collection of its own, so no schema change and no migration.
 *
 * `refs: { subject }` is doing two jobs. It is the scope every verb here
 * filters on, and it is what `erase.bySubject` sweeps generic rows by
 * (`packages/store/src/erase.ts:242`), so a forgotten person's memories go with
 * the rest of their data without this module being named anywhere in the
 * cascade.
 */
export function storeMemory(store: VendoStore): MemoryAdapter {
  const records = store.records(COLLECTION);

  /**
   * The subject axis, decided ONCE for all five verbs. Two principals cannot be
   * scoped, and `undefined` is this function's word for both: a subject that is
   * not a string at all (`Principal.subject` is required, so it took a
   * host-side type violation to get here — but `JSON.stringify` drops the
   * undefined value and the store's filter degrades to `refs @> '{}'`, which is
   * every row in the collection and a `clear` over every user), and a subject
   * carrying NUL, the one character a jsonb column refuses.
   *
   * Nobody is not everybody: an unscopable principal reads nothing and deletes
   * nothing. The write door below is where it is said out loud, because there
   * the row would have to be filed under someone.
   */
  const scope = (principal: Principal): Record<string, string> | undefined =>
    typeof principal.subject === "string" && !principal.subject.includes("\u0000")
      ? { subject: principal.subject }
      : undefined;

  /** Newest first, paged to exhaustion: `list` hands back a complete array and
   *  `clear` must not leave a second page behind. A store that repeats a cursor
   *  ends the walk rather than spinning (`ThreadStore.list`'s rule). */
  const walk = async (principal: Principal): Promise<Memory[]> => {
    const refs = scope(principal);
    if (refs === undefined) return [];
    const found: Memory[] = [];
    let cursor: string | undefined;
    do {
      const page = await records.list({ ...(cursor === undefined ? {} : { cursor }), refs });
      found.push(...page.records.map(memoryFromRecord));
      if (page.cursor === undefined || page.cursor === cursor) break;
      cursor = page.cursor;
    } while (cursor !== undefined);
    return found;
  };

  return {
    async recall(principal, limit) {
      const refs = scope(principal);
      if (refs === undefined) return [];
      const page = await records.list({ limit, refs });
      return page.records.map(memoryFromRecord).reverse();
    },
    async remember(principal, text) {
      const refs = scope(principal);
      if (refs === undefined) {
        throw new VendoError(
          "validation",
          "remember needs a principal to file the memory under: `subject` must be a plain-text string, with no NUL (U+0000).",
        );
      }
      // The text has to survive jsonb too, and a `unsupported Unicode escape
      // sequence` from Postgres is not something a model can act on.
      if (text.includes("\u0000")) {
        throw new VendoError(
          "validation",
          "remember cannot keep a NUL (U+0000) in `text` — send the fact as plain text.",
        );
      }
      const id = `mem_${randomUUID()}`;
      const kept = [...text.trim()].slice(0, MEMORY_TEXT_MAX_CHARS).join("");
      const record = await records.put({ id, data: { text: kept }, refs });
      return memoryFromRecord(record);
    },
    list: walk,
    async delete(principal, id) {
      // The subject filter is IN the lookup, so another user's memory reads back
      // as absent here exactly as a foreign thread does (`openThread`) — a
      // doctored id deletes nothing, and says nothing about what exists. The
      // delete that follows is keyed on id alone, which is safe because a row's
      // owner is written once and nothing re-owns one: there is no window for it
      // to become someone else's between the two statements.
      const refs = scope(principal);
      if (refs === undefined) return;
      const { records: [found] } = await records.list({ ids: [id], refs });
      if (found !== undefined) await records.delete(found.id);
    },
    async clear(principal) {
      for (const memory of await walk(principal)) await records.delete(memory.id);
    },
  };
}

/**
 * The write door, and the only one.
 *
 * `risk: "write"` is the honest grade: it creates durable per-user state that
 * every later turn reads, which is more than a `read` — and it is not
 * `destructive`, because a call APPENDS one row of the caller's own and
 * overwrites nothing. Forgetting belongs to the person, not the model, so there
 * is no tool for it.
 *
 * THE SUBJECT IS THE CTX'S, NEVER THE INPUT'S. A model that decides to remember
 * something "for user_b" writes to its own caller's memory, because the schema
 * gives it nothing to say so with.
 */
export const rememberTool = (memory: MemoryAdapter): HostTool =>
  tool({
    name: "remember",
    description:
      "Remember one lasting fact about the person you are talking to, so later conversations start already knowing it. "
      + "Use it when they ask you to remember something, or state a preference that outlives this conversation — never for "
      + "something only true right now. One short sentence, in their own terms.",
    risk: "write",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The fact to keep, as one short sentence." } },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const { text } = input as { text?: unknown };
      if (typeof text !== "string" || text.trim() === "") {
        throw new VendoError("validation", "remember needs `text`: the one thing to remember, as a short sentence.");
      }
      // Answering with what was STORED, not with what was asked: the model (and
      // the person reading its reply) sees the truncation rather than promising
      // a paragraph the store kept a sentence of.
      return { remembered: (await memory.remember(ctx.principal, text)).text };
    },
  });
