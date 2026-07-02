/**
 * In-memory implementations of the frozen Store seam (@flowlet/core) for
 * tests and embedded use (architecture Decision 1: embedded Store is "host's
 * choice; in-memory/SQLite in CI"). Thread/flowlet/audit stores are new; the
 * automations sub-store reuses ENG-188's InMemoryAutomationStore, which
 * already implements the frozen AutomationStore surface.
 *
 * Style matches InMemoryAutomationStore: Map state, injectable `now` clock,
 * counter ids, Principal ownership checked as `tenantId::subject`.
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

const scopeKey = (scope: Principal): string => `${scope.tenantId}::${scope.subject}`;

interface OwnedThread extends ThreadRecord {
  messages: FlowletUIMessage[];
}

export class InMemoryThreadStore implements ThreadStore {
  private threads = new Map<string, OwnedThread>();
  private idCounter = 0;
  constructor(private readonly clock: () => string) {}

  private owned(scope: Principal, thread: OwnedThread | undefined): OwnedThread | undefined {
    if (!thread) return undefined;
    return scopeKey(scope) === `${thread.tenantId}::${thread.subject}` ? thread : undefined;
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
    if (!thread) throw new Error(`unknown thread "${threadId}" for scope ${scopeKey(scope)}`);
    thread.messages.push(...messages);
    thread.updatedAt = this.clock();
  }

  async getMessages(scope: Principal, threadId: string): Promise<FlowletUIMessage[]> {
    const thread = this.owned(scope, this.threads.get(threadId));
    return thread ? [...thread.messages] : [];
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
    return scopeKey(scope) === `${f.tenantId}::${f.subject}` ? f : undefined;
  }

  async save(
    scope: Principal,
    flowlet: Omit<SavedFlowlet, "id" | "createdAt" | "updatedAt">,
  ): Promise<SavedFlowlet> {
    const now = this.clock();
    const owned: OwnedFlowlet = {
      ...flowlet,
      id: `flowlet-${++this.idCounter}`,
      createdAt: now,
      updatedAt: now,
      tenantId: scope.tenantId,
      subject: scope.subject,
    };
    this.flowlets.set(owned.id, owned);
    const { tenantId: _t, subject: _s, ...record } = owned;
    return record;
  }

  async get(scope: Principal, id: string): Promise<SavedFlowlet | undefined> {
    const owned = this.owned(scope, this.flowlets.get(id));
    if (!owned) return undefined;
    const { tenantId: _t, subject: _s, ...record } = owned;
    return record;
  }

  async list(scope: Principal): Promise<SavedFlowlet[]> {
    return [...this.flowlets.values()]
      .filter((f) => this.owned(scope, f) !== undefined)
      .map(({ tenantId: _t, subject: _s, ...record }) => record);
  }

  async delete(scope: Principal, id: string): Promise<void> {
    if (this.owned(scope, this.flowlets.get(id))) this.flowlets.delete(id);
  }
}

/** Append-only; `events` is exposed read-only so tests can assert on it. */
export class InMemoryAuditLog implements AuditLog {
  readonly events: AuditEvent[] = [];
  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
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
