import { VendoError, encodeKeySegment, type IsoDateTime, type RunContext, type StoreAdapter, type ThreadId } from "@vendoai/core";
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

/** What the store's routed vendo_threads collection carries as record data
    (02 §4: timestamps and the thread id live on the record/columns, not in data). */
interface ThreadData {
  subject: string;
  messages: UIMessage[];
}

function isThreadData(value: unknown): value is ThreadData {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ThreadData>;
  return typeof candidate.subject === "string" && Array.isArray(candidate.messages);
}

function titleFor(thread: Thread): string {
  for (const message of thread.messages) {
    if (message.role !== "user") continue;
    for (const part of message.parts) {
      if (part.type === "text") {
        const title = part.text.trim();
        return title ? title.slice(0, 80) : "New thread";
      }
    }
  }
  return "New thread";
}

function toSummary(thread: Thread): ThreadSummary {
  return { id: thread.id, title: titleFor(thread), updatedAt: thread.updatedAt };
}

function recordId(subject: string, threadId: ThreadId): string {
  // core's key-segment codec, not encodeURIComponent: the store mirrors this
  // escaping in SQL so the routed vendo_threads table can address rows by the
  // same composite key (02 §4).
  return `${encodeKeySegment(subject)}:${threadId}`;
}

/** 03-agent §5 */
export class ThreadRepository {
  readonly #memory = new Map<string, Map<ThreadId, Thread>>();

  constructor(private readonly store?: StoreAdapter) {}

  async resolve(id: ThreadId | undefined, ctx: RunContext): Promise<Thread> {
    if (id !== undefined) {
      if (!THREAD_ID_PATTERN.test(id)) {
        throw new VendoError("validation", "threadId is malformed");
      }
      const existing = await this.get(id, ctx);
      if (existing) return existing;
      return this.create(ctx, id);
    }
    return this.create(ctx);
  }

  async get(id: ThreadId, ctx: RunContext): Promise<Thread | null> {
    if (!THREAD_ID_PATTERN.test(id)) return null;
    if (this.usesMemory(ctx)) {
      return this.subjectMemory(ctx.principal.subject).get(id) ?? null;
    }
    const record = await this.store!.records(THREAD_COLLECTION)
      .get(recordId(ctx.principal.subject, id));
    if (!record || !isThreadData(record.data) || record.data.subject !== ctx.principal.subject) {
      return null;
    }
    return {
      id,
      subject: record.data.subject,
      messages: record.data.messages,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async list(ctx: RunContext): Promise<ThreadSummary[]> {
    let threads: Thread[];
    if (this.usesMemory(ctx)) {
      threads = [...this.subjectMemory(ctx.principal.subject).values()];
    } else {
      const subject = ctx.principal.subject;
      const keyPrefix = `${encodeKeySegment(subject)}:`;
      const result = await this.store!.records(THREAD_COLLECTION).list({
        refs: { subject },
      });
      threads = result.records.flatMap((record) => {
        if (!isThreadData(record.data) || record.data.subject !== subject) return [];
        if (!record.id.startsWith(keyPrefix)) return [];
        const id = record.id.slice(keyPrefix.length);
        if (!THREAD_ID_PATTERN.test(id)) return [];
        return [{
          id,
          subject,
          messages: record.data.messages,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }];
      });
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
    await this.store!.records(THREAD_COLLECTION)
      .delete(recordId(ctx.principal.subject, id));
  }

  async persist(thread: Thread, messages: UIMessage[], ctx: RunContext): Promise<void> {
    const updated: Thread = {
      ...thread,
      messages,
      updatedAt: new Date().toISOString(),
    };
    if (this.usesMemory(ctx)) {
      this.subjectMemory(ctx.principal.subject).set(updated.id, updated);
      return;
    }
    const data: ThreadData = { subject: updated.subject, messages: updated.messages };
    await this.store!.records(THREAD_COLLECTION).put({
      id: recordId(updated.subject, updated.id),
      // ai-SDK UIMessages carry undefined-valued optional fields; the store's
      // records seam takes strict Json, so persist the JSON form.
      data: JSON.parse(JSON.stringify(data)),
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
