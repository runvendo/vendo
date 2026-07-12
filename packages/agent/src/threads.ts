import { VendoError, type IsoDateTime, type RunContext, type StoreAdapter, type ThreadId, type VendoRecord } from "@vendoai/core";
import type { UIMessage } from "ai";
import { mintThreadId } from "./ids.js";

const THREAD_COLLECTION = "vendo_threads";
const THREAD_ID_PATTERN = /^thr_.+$/;

/** 03-agent §5 */
export interface Thread {
  id: ThreadId;
  subject: string;
  messages: UIMessage[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** 03-agent §5 */
export interface ThreadSummary {
  id: ThreadId;
  title: string;
  updatedAt: IsoDateTime;
}

/** Reconstruct a Thread from a store record. The store seam (core §12) carries
 *  the id + timestamps on the VendoRecord envelope and the reserved
 *  vendo_threads routing projects `data` down to `{ subject, messages }` (02
 *  §2) — so the whole Thread is never inside `data`. Read it back from the
 *  envelope, not from `data`. */
function threadFromRecord(record: VendoRecord): Thread | null {
  if (!THREAD_ID_PATTERN.test(record.id)) return null;
  // Timestamps ride the envelope, but a hand-written row (threadStore(store).put
  // accepts any Json) could still be malformed — validate before trusting them so
  // one bad row cannot brick the whole listing.
  if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") return null;
  const data = record.data;
  if (typeof data !== "object" || data === null) return null;
  const candidate = data as { subject?: unknown; messages?: unknown };
  if (typeof candidate.subject !== "string" || !Array.isArray(candidate.messages)) return null;
  return {
    id: record.id,
    subject: candidate.subject,
    messages: candidate.messages as UIMessage[],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function titleFor(thread: Thread): string {
  // Messages come from a Json array (parseThreadData accepts any shape), so a
  // message may lack an iterable `parts` or carry non-text parts — tolerate both,
  // skipping rather than throwing.
  for (const message of thread.messages) {
    if (message === null || typeof message !== "object") continue;
    if ((message as { role?: unknown }).role !== "user") continue;
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part !== null && typeof part === "object"
        && (part as { type?: unknown }).type === "text"
        && typeof (part as { text?: unknown }).text === "string") {
        const title = (part as { text: string }).text.trim();
        return title ? title.slice(0, 80) : "New thread";
      }
    }
  }
  return "New thread";
}

function toSummary(thread: Thread): ThreadSummary {
  return { id: thread.id, title: titleFor(thread), updatedAt: thread.updatedAt };
}

/** Serialize to plain JSON so the value satisfies the store seam's `Json` type
 *  (drops explicit `undefined`-valued props that JSON.stringify would omit). */
function toPlainJson(messages: UIMessage[]): UIMessage[] {
  return JSON.parse(JSON.stringify(messages)) as UIMessage[];
}

/** 03-agent §5 */
export class ThreadRepository {
  readonly #memory = new Map<string, Map<ThreadId, Thread>>();

  constructor(private readonly store?: StoreAdapter) {}

  async resolve(id: ThreadId | undefined, ctx: RunContext): Promise<Thread> {
    if (id === undefined) return this.create(ctx);
    if (!THREAD_ID_PATTERN.test(id)) {
      throw new VendoError("validation", "threadId is malformed");
    }
    // Memory paths (no store / ephemeral) use per-subject maps, so ids are private
    // and no takeover is possible — resolve straight from this subject's map.
    if (this.usesMemory(ctx)) {
      return this.subjectMemory(ctx.principal.subject).get(id) ?? this.create(ctx, id);
    }
    // ONE ownership-blind read is the friendly fast-path (03 §5). vendo_threads is
    // keyed by the bare id, so a foreign row reads as non-null here; reusing the id
    // would let persist() take it over. Free id → create; ours → return; anyone
    // else's (or unparseable) → conflict. The store's guarded upsert is the real,
    // atomic guarantee — this only surfaces the conflict early with a clear error.
    const record = await this.store!.records(THREAD_COLLECTION).get(id);
    if (record === null) return this.create(ctx, id);
    const thread = threadFromRecord(record);
    if (thread !== null && thread.subject === ctx.principal.subject) return thread;
    throw new VendoError("conflict", "threadId is already in use");
  }

  async get(id: ThreadId, ctx: RunContext): Promise<Thread | null> {
    if (!THREAD_ID_PATTERN.test(id)) return null;
    if (this.usesMemory(ctx)) {
      return this.subjectMemory(ctx.principal.subject).get(id) ?? null;
    }
    // Reserved vendo_threads rows are keyed by the bare thread id (02 §2:
    // `id` is the thread id). Subject scoping is enforced here, on read, by
    // checking the row's subject — never returning another subject's thread.
    const record = await this.store!.records(THREAD_COLLECTION).get(id);
    if (!record) return null;
    const thread = threadFromRecord(record);
    if (!thread || thread.subject !== ctx.principal.subject) return null;
    return thread;
  }

  async list(ctx: RunContext): Promise<ThreadSummary[]> {
    let threads: Thread[];
    if (this.usesMemory(ctx)) {
      threads = [...this.subjectMemory(ctx.principal.subject).values()];
    } else {
      // Follow the cursor to exhaustion (the store pages at 100) — otherwise a
      // subject's >100th thread, possibly their most recently active, vanishes
      // (list orders by created_at, we re-sort by updatedAt below).
      const records: VendoRecord[] = [];
      let cursor: string | undefined;
      do {
        const result = await this.store!.records(THREAD_COLLECTION).list({
          refs: { subject: ctx.principal.subject },
          ...(cursor === undefined ? {} : { cursor }),
        });
        records.push(...result.records);
        cursor = result.cursor;
      } while (cursor !== undefined);
      threads = records
        .map(threadFromRecord)
        .filter((thread): thread is Thread => thread !== null && thread.subject === ctx.principal.subject);
    }
    return threads
      .map(toSummary)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async delete(id: ThreadId, ctx: RunContext): Promise<void> {
    if (!THREAD_ID_PATTERN.test(id)) return;
    if (this.usesMemory(ctx)) {
      this.subjectMemory(ctx.principal.subject).delete(id);
      return;
    }
    // The bare id is shared across subjects; delete only after confirming the
    // row belongs to this subject (get() returns null otherwise), so one
    // subject can never delete another's thread (03 §5).
    const existing = await this.get(id, ctx);
    if (existing === null) return;
    await this.store!.records(THREAD_COLLECTION).delete(id);
  }

  async persist(thread: Thread, messages: UIMessage[], ctx: RunContext): Promise<void> {
    const updated: Thread = {
      ...thread,
      // ai-SDK UIMessages carry explicit `undefined`-valued optional props on
      // tool parts (e.g. an approval-requested part with no output yet). The
      // store seam is typed `Json` and rejects `undefined` values, so serialize
      // to plain JSON — dropping absent-anyway keys — before it crosses.
      messages: toPlainJson(messages),
      updatedAt: new Date().toISOString(),
    };
    if (this.usesMemory(ctx)) {
      this.subjectMemory(ctx.principal.subject).set(updated.id, updated);
      return;
    }
    await this.store!.records(THREAD_COLLECTION).put({
      id: updated.id,
      data: updated,
      refs: { subject: updated.subject },
    });
  }

  private create(ctx: RunContext, requestedId?: ThreadId): Thread {
    const now = new Date().toISOString();
    const thread: Thread = {
      id: requestedId ?? mintThreadId(),
      subject: ctx.principal.subject,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    if (this.usesMemory(ctx)) {
      this.subjectMemory(ctx.principal.subject).set(thread.id, thread);
    }
    return thread;
  }

  private usesMemory(ctx: RunContext): boolean {
    return this.store === undefined || ctx.principal.ephemeral === true;
  }

  private subjectMemory(subject: string): Map<ThreadId, Thread> {
    let threads = this.#memory.get(subject);
    if (!threads) {
      threads = new Map();
      this.#memory.set(subject, threads);
    }
    return threads;
  }
}
