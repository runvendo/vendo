import { VendoError, type IsoDateTime, type RunContext, type StoreAdapter, type ThreadId } from "@vendoai/core";
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

function isThread(value: unknown): value is Thread {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Thread>;
  return typeof candidate.id === "string"
    && THREAD_ID_PATTERN.test(candidate.id)
    && typeof candidate.subject === "string"
    && Array.isArray(candidate.messages)
    && typeof candidate.createdAt === "string"
    && typeof candidate.updatedAt === "string";
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
      if (!this.usesMemory(ctx)) {
        const occupied = await this.store!.records(THREAD_COLLECTION).get(id);
        if (occupied) throw new VendoError("not-found", "thread not found");
      }
      return this.create(ctx, id);
    }
    return this.create(ctx);
  }

  async get(id: ThreadId, ctx: RunContext): Promise<Thread | null> {
    if (!THREAD_ID_PATTERN.test(id)) return null;
    if (this.usesMemory(ctx)) {
      return this.subjectMemory(ctx.principal.subject).get(id) ?? null;
    }
    const record = await this.store!.records(THREAD_COLLECTION).get(id);
    if (!record || !isThread(record.data) || record.data.subject !== ctx.principal.subject) {
      return null;
    }
    return record.data;
  }

  async list(ctx: RunContext): Promise<ThreadSummary[]> {
    let threads: Thread[];
    if (this.usesMemory(ctx)) {
      threads = [...this.subjectMemory(ctx.principal.subject).values()];
    } else {
      const result = await this.store!.records(THREAD_COLLECTION).list({
        refs: { subject: ctx.principal.subject },
      });
      threads = result.records
        .map((record) => record.data)
        .filter((data): data is Thread => isThread(data) && data.subject === ctx.principal.subject);
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
    const thread = await this.get(id, ctx);
    if (thread) await this.store!.records(THREAD_COLLECTION).delete(id);
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
