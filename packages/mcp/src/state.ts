import type { RunContext } from "@vendoai/core";

/** The RunContext the door mints for every MCP tool call. The OAuth consent is
 * structural because actions cannot import this package (dependency guard). */
export type McpRunContext = RunContext & {
  mcpConsent: { clientId: string; scopes: string[] };
};

/** An opaque transport/runtime handle associated with the current protocol's
 * session key. A stateless transport can supply this from request scope. */
export interface McpStateSession {
  readonly subject: string;
  /** Opaque approval-replay namespace. The 2025-11-25 adapter uses its MCP
   * session id; a stateless adapter supplies an authenticated durable scope. */
  replayScope: string;
  context: McpRunContext;
  handleRequest(req: Request): Promise<Response>;
  close(): Promise<void>;
}

export interface SessionStateRecord {
  sessionId: string;
  subject: string;
  session: McpStateSession;
  expiresAt: number;
}

export interface ReplayStateOptions {
  /** Authenticated owner used for fail-closed revocation cleanup. */
  subject: string;
  /** Absolute wall-clock expiry, shared with the owning context/session. */
  expiresAt: number;
  /** Maximum fingerprints retained for one context key. */
  capacity: number;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Internal state seam for the MCP transport lifetime.
 *
 * Keys and absolute expiries make the contract implementable over a durable
 * store; MaybePromise keeps the default in-memory callbacks synchronous while
 * allowing a store-backed adapter to perform I/O. Session values are opaque:
 * the 2025-11-25 adapter supplies its SDK runtime, while a future stateless
 * adapter can supply a request-scoped runtime and durably store only replay
 * records and serializable context metadata.
 */
export interface McpDoorState {
  /** Session methods serve the 2025-11-25 transport runtime. Implementations
   * must remove replay records for the same key whenever a session is removed. */
  getSession(sessionId: string): MaybePromise<McpStateSession | null>;
  setSession(record: SessionStateRecord): MaybePromise<void>;
  /** Extends both the session and every replay entry scoped to its key. */
  touchSession(sessionId: string, expiresAt: number): MaybePromise<void>;
  deleteSession(sessionId: string): MaybePromise<McpStateSession | null>;
  /** Removes every session and replay record owned by the subject. */
  deleteSessionsBySubject(subject: string): MaybePromise<McpStateSession[]>;
  /** Atomically removes and returns every session whose expiry is <= now. */
  sweepExpiredSessions(now: number): MaybePromise<McpStateSession[]>;

  /** Replay methods are transport-neutral: callers supply the opaque context
   * scope, canonical call fingerprint, and absolute expiry. */
  getReplay(scope: string, key: string, now: number): MaybePromise<string | null>;
  setReplay(
    scope: string,
    key: string,
    callId: string,
    options: ReplayStateOptions,
  ): MaybePromise<void>;
  deleteReplay(scope: string, key: string): MaybePromise<void>;
}

interface ReplayRecord {
  callId: string;
  subject: string;
  expiresAt: number;
}

/** Today's byte-compatible process-memory implementation. */
export class InMemoryMcpDoorState implements McpDoorState {
  readonly #sessions = new Map<string, SessionStateRecord>();
  readonly #subjectSessions = new Map<string, Set<string>>();
  readonly #replay = new Map<string, Map<string, ReplayRecord>>();

  getSession(sessionId: string): McpStateSession | null {
    return this.#sessions.get(sessionId)?.session ?? null;
  }

  setSession(record: SessionStateRecord): void {
    const previous = this.#sessions.get(record.sessionId);
    if (previous?.subject !== undefined && previous.subject !== record.subject) {
      this.#removeSubjectSession(previous.subject, record.sessionId);
    }
    this.#sessions.set(record.sessionId, record);
    const sessions = this.#subjectSessions.get(record.subject) ?? new Set<string>();
    sessions.add(record.sessionId);
    this.#subjectSessions.set(record.subject, sessions);
  }

  touchSession(sessionId: string, expiresAt: number): void {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) return;
    record.expiresAt = expiresAt;
    for (const replay of this.#replay.get(record.session.replayScope)?.values() ?? []) {
      replay.expiresAt = expiresAt;
    }
  }

  deleteSession(sessionId: string): McpStateSession | null {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) return null;
    this.#sessions.delete(sessionId);
    this.#replay.delete(record.session.replayScope);
    this.#removeSubjectSession(record.subject, sessionId);
    return record.session;
  }

  deleteSessionsBySubject(subject: string): McpStateSession[] {
    const sessions: McpStateSession[] = [];
    for (const sessionId of [...(this.#subjectSessions.get(subject) ?? [])]) {
      const session = this.deleteSession(sessionId);
      if (session !== null) sessions.push(session);
    }
    for (const [scope, entries] of this.#replay) {
      for (const [key, replay] of entries) {
        if (replay.subject === subject) entries.delete(key);
      }
      if (entries.size === 0) this.#replay.delete(scope);
    }
    return sessions;
  }

  sweepExpiredSessions(now: number): McpStateSession[] {
    const expired: McpStateSession[] = [];
    for (const [sessionId, record] of [...this.#sessions]) {
      if (record.expiresAt > now) continue;
      const session = this.deleteSession(sessionId);
      if (session !== null) expired.push(session);
    }
    return expired;
  }

  getReplay(scope: string, key: string, now: number): string | null {
    const entries = this.#replay.get(scope);
    const record = entries?.get(key);
    if (record === undefined) return null;
    if (record.expiresAt > now) return record.callId;
    entries!.delete(key);
    if (entries!.size === 0) this.#replay.delete(scope);
    return null;
  }

  setReplay(scope: string, key: string, callId: string, options: ReplayStateOptions): void {
    const entries = this.#replay.get(scope) ?? new Map<string, ReplayRecord>();
    if (!entries.has(key) && entries.size >= options.capacity) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    entries.set(key, {
      callId,
      subject: options.subject,
      expiresAt: options.expiresAt,
    });
    this.#replay.set(scope, entries);
  }

  deleteReplay(scope: string, key: string): void {
    const entries = this.#replay.get(scope);
    entries?.delete(key);
    if (entries?.size === 0) this.#replay.delete(scope);
  }

  #removeSubjectSession(subject: string, sessionId: string): void {
    const sessions = this.#subjectSessions.get(subject);
    sessions?.delete(sessionId);
    if (sessions?.size === 0) this.#subjectSessions.delete(subject);
  }
}
