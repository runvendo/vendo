/**
 * In-memory implementations of the frozen Store seam (@flowlet/core) for
 * tests and embedded use (architecture Decision 1: embedded Store is "host's
 * choice; in-memory/SQLite in CI"). Thread/flowlet/audit stores are new; the
 * automations sub-store reuses ENG-188's InMemoryAutomationStore, which
 * already implements the frozen AutomationStore surface.
 *
 * Style matches InMemoryAutomationStore: Map state, injectable `now` clock,
 * counter ids. Two deliberate hardenings over that style (PR #22 review):
 * Principal ownership compares tenantId and subject as FIELDS (a delimiter
 * key would let {a, b::c} and {a::b, c} collide), and everything that crosses
 * the store boundary is structuredClone'd so callers can never mutate
 * persisted state through retained references — the cloud Postgres store gets
 * both properties for free from serialization, and this stand-in must match.
 */
import type {
  AuditEvent,
  AuditLog,
  FlowletUIMessage,
  Principal,
  SavedFlowlet,
  SavedFlowletStore,
  Store,
  ThreadRecord,
  ThreadStore,
} from "@flowlet/core";
import { InMemoryAutomationStore } from "../automations/store";

const sameScope = (scope: Principal, owned: { tenantId: string; subject: string }): boolean =>
  scope.tenantId === owned.tenantId && scope.subject === owned.subject;

interface OwnedThread extends ThreadRecord {
  messages: FlowletUIMessage[];
}

export class InMemoryThreadStore implements ThreadStore {
  private threads = new Map<string, OwnedThread>();
  private idCounter = 0;
  constructor(private readonly clock: () => string) {}

  private owned(scope: Principal, thread: OwnedThread | undefined): OwnedThread | undefined {
    if (!thread) return undefined;
    return sameScope(scope, thread) ? thread : undefined;
  }

  async create(scope: Principal, init: { title?: string } = {}): Promise<ThreadRecord> {
    const now = this.clock();
    const thread: OwnedThread = {
      id: `thread-${++this.idCounter}`,
      tenantId: scope.tenantId,
      subject: scope.subject,
      ...(init.title !== undefined ? { title: init.title } : {}),
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.threads.set(thread.id, thread);
    const { messages: _messages, ...record } = thread;
    return record;
  }

  async get(scope: Principal, threadId: string): Promise<ThreadRecord | undefined> {
    const thread = this.owned(scope, this.threads.get(threadId));
    if (!thread) return undefined;
    const { messages: _messages, ...record } = thread;
    return record;
  }

  async list(scope: Principal): Promise<ThreadRecord[]> {
    return [...this.threads.values()]
      .filter((t) => this.owned(scope, t) !== undefined)
      .map(({ messages: _messages, ...record }) => record);
  }

  async appendMessages(
    scope: Principal,
    threadId: string,
    messages: FlowletUIMessage[],
  ): Promise<void> {
    const thread = this.owned(scope, this.threads.get(threadId));
    if (!thread) {
      throw new Error(
        `unknown thread "${threadId}" for scope ${scope.tenantId}/${scope.subject}`,
      );
    }
    thread.messages.push(...structuredClone(messages));
    thread.updatedAt = this.clock();
  }

  async getMessages(scope: Principal, threadId: string): Promise<FlowletUIMessage[]> {
    const thread = this.owned(scope, this.threads.get(threadId));
    return thread ? structuredClone(thread.messages) : [];
  }
}

interface OwnedFlowlet extends SavedFlowlet {
  tenantId: string;
  subject: string;
}

export class InMemorySavedFlowletStore implements SavedFlowletStore {
  private flowlets = new Map<string, OwnedFlowlet>();
  private idCounter = 0;
  constructor(private readonly clock: () => string) {}

  private owned(scope: Principal, f: OwnedFlowlet | undefined): OwnedFlowlet | undefined {
    if (!f) return undefined;
    return sameScope(scope, f) ? f : undefined;
  }

  async save(
    scope: Principal,
    flowlet: Omit<SavedFlowlet, "id" | "createdAt" | "updatedAt">,
  ): Promise<SavedFlowlet> {
    const now = this.clock();
    const owned: OwnedFlowlet = {
      ...structuredClone(flowlet),
      id: `flowlet-${++this.idCounter}`,
      createdAt: now,
      updatedAt: now,
      tenantId: scope.tenantId,
      subject: scope.subject,
    };
    this.flowlets.set(owned.id, owned);
    return this.toRecord(owned);
  }

  async get(scope: Principal, id: string): Promise<SavedFlowlet | undefined> {
    const owned = this.owned(scope, this.flowlets.get(id));
    return owned ? this.toRecord(owned) : undefined;
  }

  async list(scope: Principal): Promise<SavedFlowlet[]> {
    return [...this.flowlets.values()]
      .filter((f) => this.owned(scope, f) !== undefined)
      .map((f) => this.toRecord(f));
  }

  private toRecord(owned: OwnedFlowlet): SavedFlowlet {
    const { tenantId: _t, subject: _s, ...record } = structuredClone(owned);
    return record;
  }

  async delete(scope: Principal, id: string): Promise<void> {
    if (this.owned(scope, this.flowlets.get(id))) this.flowlets.delete(id);
  }
}

/** Append-only: the log clones on both sides of the boundary, so neither the
 *  caller's event object nor anything read via `events` is a live reference. */
export class InMemoryAuditLog implements AuditLog {
  private log: AuditEvent[] = [];

  /** A detached copy for tests/inspection — mutating it never touches the log. */
  get events(): AuditEvent[] {
    return structuredClone(this.log);
  }

  async append(event: AuditEvent): Promise<void> {
    this.log.push(structuredClone(event));
  }

  /** Read API (ENG-193 §6.2): principal-scoped, newest first. */
  async query(
    scope: Principal,
    filter?: { kinds?: AuditEvent["kind"][]; since?: string; limit?: number },
  ): Promise<AuditEvent[]> {
    let rows = this.log.filter((e) => sameScope(scope, e.principal));
    if (filter?.kinds) rows = rows.filter((e) => (filter.kinds as string[]).includes(e.kind));
    if (filter?.since !== undefined) rows = rows.filter((e) => e.at >= filter.since!);
    rows = [...rows].reverse();
    if (filter?.limit !== undefined) rows = rows.slice(0, filter.limit);
    return structuredClone(rows);
  }
}

export interface InMemoryStore extends Store {
  threads: InMemoryThreadStore;
  flowlets: InMemorySavedFlowletStore;
  automations: InMemoryAutomationStore;
  audit: InMemoryAuditLog;
}

export function createInMemoryStore(opts: { now?: () => string } = {}): InMemoryStore {
  const clock = opts.now ?? (() => new Date().toISOString());
  return {
    threads: new InMemoryThreadStore(clock),
    flowlets: new InMemorySavedFlowletStore(clock),
    automations: new InMemoryAutomationStore({ now: clock }),
    audit: new InMemoryAuditLog(),
  };
}
