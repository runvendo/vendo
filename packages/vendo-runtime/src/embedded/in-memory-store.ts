/**
 * In-memory implementations of the frozen Store seam (@vendoai/core) for
 * tests and embedded use (architecture Decision 1: embedded Store is "host's
 * choice; in-memory/SQLite in CI"). Thread/vendo/audit stores are new; the
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
  VendoUIMessage,
  Principal,
  RemixRecord,
  RemixStore,
  SavedVendo,
  SavedVendoStore,
  Store,
  ThreadRecord,
  ThreadStore,
} from "@vendoai/core";
import { InMemoryAutomationStore } from "../automations/store.js";

const sameScope = (scope: Principal, owned: { tenantId: string; subject: string }): boolean =>
  scope.tenantId === owned.tenantId && scope.subject === owned.subject;

interface OwnedThread extends ThreadRecord {
  messages: VendoUIMessage[];
}

export class InMemoryThreadStore implements ThreadStore {
  // Keyed by JSON-encoded [tenantId, subject, threadId] rather than threadId
  // alone: upsertMessages lets the client supply its own threadId (auto-create
  // on first write), and two principals may legitimately reuse the same id
  // string. Array-of-strings JSON encoding is collision-free the way naive
  // delimiter concatenation is not (see the "Principal scope integrity" test
  // below, a real regression from PR #22 review).
  private threads = new Map<string, OwnedThread>();
  private idCounter = 0;
  constructor(private readonly clock: () => string) {}

  private key(scope: Principal, threadId: string): string {
    return JSON.stringify([scope.tenantId, scope.subject, threadId]);
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
    this.threads.set(this.key(scope, thread.id), thread);
    const { messages: _messages, ...record } = thread;
    return record;
  }

  async get(scope: Principal, threadId: string): Promise<ThreadRecord | undefined> {
    const thread = this.threads.get(this.key(scope, threadId));
    if (!thread) return undefined;
    const { messages: _messages, ...record } = thread;
    return record;
  }

  async list(scope: Principal): Promise<ThreadRecord[]> {
    return [...this.threads.values()]
      .filter((t) => sameScope(scope, t))
      .map(({ messages: _messages, ...record }) => record);
  }

  async appendMessages(
    scope: Principal,
    threadId: string,
    messages: VendoUIMessage[],
  ): Promise<void> {
    const thread = this.threads.get(this.key(scope, threadId));
    if (!thread) {
      throw new Error(
        `unknown thread "${threadId}" for scope ${scope.tenantId}/${scope.subject}`,
      );
    }
    thread.messages.push(...structuredClone(messages));
    thread.updatedAt = this.clock();
  }

  async getMessages(scope: Principal, threadId: string): Promise<VendoUIMessage[]> {
    const thread = this.threads.get(this.key(scope, threadId));
    return thread ? structuredClone(thread.messages) : [];
  }

  /** Full-list replace for settle hooks (see the seam docstring): continuation
   *  turns revise the trailing assistant message in place, which append-only
   *  deltas can never persist. */
  async replaceMessages(
    scope: Principal,
    threadId: string,
    messages: VendoUIMessage[],
  ): Promise<void> {
    const thread = this.threads.get(this.key(scope, threadId));
    if (!thread) {
      throw new Error(
        `unknown thread "${threadId}" for scope ${scope.tenantId}/${scope.subject}`,
      );
    }
    thread.messages = structuredClone(messages);
    thread.updatedAt = this.clock();
  }

  async upsertMessages(
    scope: Principal,
    threadId: string,
    messages: VendoUIMessage[],
  ): Promise<void> {
    const key = this.key(scope, threadId);
    let thread = this.threads.get(key);
    const now = this.clock();
    if (!thread) {
      // The client owns thread ids for upsert (ai-SDK resume writes before
      // any explicit create() call) — an unrecognized threadId is a
      // first-write, not an error.
      thread = {
        id: threadId,
        tenantId: scope.tenantId,
        subject: scope.subject,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      this.threads.set(key, thread);
    }
    for (const incoming of structuredClone(messages)) {
      const index = thread.messages.findIndex((m) => m.id === incoming.id);
      if (index === -1) thread.messages.push(incoming);
      else thread.messages[index] = incoming;
    }
    thread.updatedAt = now;
  }
}

interface OwnedVendo extends SavedVendo {
  tenantId: string;
  subject: string;
}

export class InMemorySavedVendoStore implements SavedVendoStore {
  private vendos = new Map<string, OwnedVendo>();
  private idCounter = 0;
  constructor(private readonly clock: () => string) {}

  private owned(scope: Principal, f: OwnedVendo | undefined): OwnedVendo | undefined {
    if (!f) return undefined;
    return sameScope(scope, f) ? f : undefined;
  }

  async save(
    scope: Principal,
    vendo: Omit<SavedVendo, "id" | "createdAt" | "updatedAt">,
  ): Promise<SavedVendo> {
    const now = this.clock();
    const owned: OwnedVendo = {
      ...structuredClone(vendo),
      id: `vendo-${++this.idCounter}`,
      createdAt: now,
      updatedAt: now,
      tenantId: scope.tenantId,
      subject: scope.subject,
    };
    this.vendos.set(owned.id, owned);
    return this.toRecord(owned);
  }

  async get(scope: Principal, id: string): Promise<SavedVendo | undefined> {
    const owned = this.owned(scope, this.vendos.get(id));
    return owned ? this.toRecord(owned) : undefined;
  }

  async list(scope: Principal): Promise<SavedVendo[]> {
    return [...this.vendos.values()]
      .filter((f) => this.owned(scope, f) !== undefined)
      .map((f) => this.toRecord(f));
  }

  private toRecord(owned: OwnedVendo): SavedVendo {
    const { tenantId: _t, subject: _s, ...record } = structuredClone(owned);
    return record;
  }

  async delete(scope: Principal, id: string): Promise<void> {
    if (this.owned(scope, this.vendos.get(id))) this.vendos.delete(id);
  }
}

interface OwnedRemix extends RemixRecord {
  tenantId: string;
  subject: string;
}

export class InMemoryRemixStore implements RemixStore {
  /** Keyed by anchorId → owned records; ownership compared as fields. */
  private pins = new Map<string, OwnedRemix[]>();
  constructor(private readonly clock: () => string) {}

  private find(scope: Principal, anchorId: string): OwnedRemix | undefined {
    return this.pins.get(anchorId)?.find((r) => sameScope(scope, r));
  }

  async pin(
    scope: Principal,
    anchorId: string,
    record: Omit<RemixRecord, "anchorId" | "createdAt" | "updatedAt">,
  ): Promise<RemixRecord> {
    const now = this.clock();
    const existing = this.find(scope, anchorId);
    const owned: OwnedRemix = {
      ...structuredClone(record),
      anchorId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      tenantId: scope.tenantId,
      subject: scope.subject,
    };
    const rest = (this.pins.get(anchorId) ?? []).filter((r) => !sameScope(scope, r));
    this.pins.set(anchorId, [...rest, owned]);
    return this.toRecord(owned);
  }

  async get(scope: Principal, anchorId: string): Promise<RemixRecord | undefined> {
    const owned = this.find(scope, anchorId);
    return owned ? this.toRecord(owned) : undefined;
  }

  async unpin(scope: Principal, anchorId: string): Promise<void> {
    const rest = (this.pins.get(anchorId) ?? []).filter((r) => !sameScope(scope, r));
    if (rest.length === 0) this.pins.delete(anchorId);
    else this.pins.set(anchorId, rest);
  }

  private toRecord(owned: OwnedRemix): RemixRecord {
    const { tenantId: _t, subject: _s, ...record } = structuredClone(owned);
    return record;
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

  /** Read API (ENG-193 §6.2): principal-scoped, ordered by `at` descending.
   *  `since` is inclusive; an empty `kinds` array means no kind filter. */
  async query(
    scope: Principal,
    filter?: { kinds?: AuditEvent["kind"][]; since?: string; limit?: number },
  ): Promise<AuditEvent[]> {
    let rows = this.log.filter((e) => sameScope(scope, e.principal));
    if (filter?.kinds && filter.kinds.length > 0) {
      rows = rows.filter((e) => (filter.kinds as string[]).includes(e.kind));
    }
    if (filter?.since !== undefined) rows = rows.filter((e) => e.at >= filter.since!);
    rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    if (filter?.limit !== undefined) rows = rows.slice(0, filter.limit);
    return structuredClone(rows);
  }
}

export interface InMemoryStore extends Store {
  threads: InMemoryThreadStore;
  vendos: InMemorySavedVendoStore;
  automations: InMemoryAutomationStore;
  audit: InMemoryAuditLog;
  remixes: InMemoryRemixStore;
}

export function createInMemoryStore(opts: { now?: () => string } = {}): InMemoryStore {
  const clock = opts.now ?? (() => new Date().toISOString());
  return {
    threads: new InMemoryThreadStore(clock),
    vendos: new InMemorySavedVendoStore(clock),
    automations: new InMemoryAutomationStore({ now: clock }),
    audit: new InMemoryAuditLog(),
    remixes: new InMemoryRemixStore(clock),
  };
}
