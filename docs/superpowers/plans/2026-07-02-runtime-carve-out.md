# Runtime Carve-Out (@flowlet/runtime) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `@flowlet/runtime` (new `packages/flowlet-runtime`) out of `flowlet-agent` so the portable agent runtime (loop, tool calling, policy, UI-gen tool, automations engine) depends only on the five frozen seams plus `@flowlet/core` contracts — with in-memory implementations of all five seams, demo-bank running on the carved runtime with zero behavior change, and a permanent dependency-lint CI guard.

**Architecture:** Platform architecture Decisions 1 and 7 (2026-07-01): `@flowlet/runtime` evolves `flowlet-agent` and never imports a database, queue, or HTTP server. `flowlet-agent` already has a clean dependency surface (ai SDK, Composio, zod, croner, jsonata, sucrase, @flowlet/core), so the carve-out is a package rename plus new embedded seam implementations plus the guard — behavior-preserving, no new features.

**Decision — flowlet-agent is ABSORBED, not kept as a compat shim.** Rationale: the architecture doc itself says flowlet-runtime "evolves flowlet-agent"; every consumer is in-repo (demo-bank, examples/basic); a permanent `@flowlet/agent` re-export package would be dead weight, give one library two names, and force the dependency guard to police two packages. Surfaced in the PR description for Yousef's review before merge.

**Coordination constraint (eng-184-brand-native):** that session concurrently edits prompt/codegen-guidance/render_view-description files (`engine.ts`, `render-view-tool.ts`, `compile-component.ts` in flowlet-agent; files in flowlet-components). This plan NEVER edits those files' contents. The whole package moves in ONE pure `git mv` commit (no content changes), so git rename detection makes their rebase clean. flowlet-components is untouched. We merge first; they rebase onto us.

**Tech Stack:** TypeScript, pnpm workspaces, turbo, vitest.

---

### Task 1: Pure rename — `git mv packages/flowlet-agent packages/flowlet-runtime`

**Files:**
- Move: `packages/flowlet-agent/**` → `packages/flowlet-runtime/**` (no content edits whatsoever)

- [ ] **Step 1: Move the package directory**

```bash
git mv packages/flowlet-agent packages/flowlet-runtime
```

- [ ] **Step 2: Verify the move is 100% renames**

Run: `git status --short | grep -v "^R" | head`
Expected: empty output (every entry is `R` rename).

- [ ] **Step 3: Commit immediately (nothing else in this commit)**

```bash
git commit -m "refactor(runtime): git mv flowlet-agent -> flowlet-runtime (pure rename, no content changes)"
```

### Task 2: Package identity — `@flowlet/runtime`

**Files:**
- Modify: `packages/flowlet-runtime/package.json` (name only)
- Modify: `packages/flowlet-runtime/src/index.ts` (header comment + package const)
- Modify: `packages/flowlet-runtime/src/engine.live.test.ts`, `packages/flowlet-runtime/src/composio.live.test.ts` (self-imports)
- Modify: `packages/flowlet-runtime/README.md` (name references)

- [ ] **Step 1: Rename the package**

In `packages/flowlet-runtime/package.json` change:

```json
  "name": "@flowlet/runtime",
```

- [ ] **Step 2: Update the index header and const**

In `packages/flowlet-runtime/src/index.ts` replace lines 1–5 with:

```ts
/**
 * Public API surface for `@flowlet/runtime` — Flowlet's portable agent runtime
 * (architecture Decision 1: loop, tool calling, policy, UI generation,
 * automations; depends only on the five frozen seams + @flowlet/core).
 */

export const FLOWLET_RUNTIME_PACKAGE = "@flowlet/runtime";
```

(`FLOWLET_AGENT_PACKAGE` has no other reference in the repo — verified by grep — so no alias is kept.)

- [ ] **Step 3: Update self-imports in the live tests**

In `src/engine.live.test.ts` and `src/composio.live.test.ts` replace `"@flowlet/agent"` with `"@flowlet/runtime"` in import statements.

- [ ] **Step 4: Update README title/name references**

Replace `@flowlet/agent` / `flowlet-agent` mentions in `packages/flowlet-runtime/README.md` with the runtime name (keep the F2 history line if present; add one sentence: "Renamed from `@flowlet/agent` in the 2026-07-02 runtime carve-out.").

- [ ] **Step 5: Refresh the lockfile and verify the package builds and tests green in isolation**

```bash
pnpm install
pnpm --filter @flowlet/runtime build
pnpm --filter @flowlet/runtime test
```

Expected: install rewrites `pnpm-lock.yaml`; build and tests PASS (live tests self-skip without keys).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(runtime): rename package identity to @flowlet/runtime"
```

### Task 3: Rewire consumers (demo-bank, examples/basic, shell comment)

**Files:**
- Modify: `apps/demo-bank/package.json` (dep swap)
- Modify: `apps/demo-bank/src/flowlet/{_test-helpers,action-handler,agent,automations,chat-handler,composio-server,policy,principal}.ts` and `apps/demo-bank/src/flowlet/policy.test.ts` (import swap)
- Modify: `examples/basic/package.json`, `examples/basic/src/realAgent.ts`
- Modify: `packages/flowlet-shell/src/use-flowlet-thread.ts:45` (comment mentions `@flowlet/agent`)

- [ ] **Step 1: Swap the dependency in both consumer manifests**

In `apps/demo-bank/package.json` and `examples/basic/package.json` replace:

```json
    "@flowlet/agent": "workspace:*",
```

with:

```json
    "@flowlet/runtime": "workspace:*",
```

- [ ] **Step 2: Swap every import specifier**

```bash
grep -rl '"@flowlet/agent"' apps/demo-bank/src examples/basic/src | xargs sed -i '' 's|"@flowlet/agent"|"@flowlet/runtime"|g'
```

- [ ] **Step 3: Fix the stale comment in flowlet-shell**

In `packages/flowlet-shell/src/use-flowlet-thread.ts:45` change `` `@flowlet/agent` `` to `` `@flowlet/runtime` `` (comment only).

- [ ] **Step 4: Verify no references remain and everything is green**

```bash
grep -rn "@flowlet/agent\|flowlet-agent" --include="*.ts" --include="*.tsx" --include="*.json" --exclude-dir=node_modules --exclude-dir=dist . ; \
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

Expected: grep finds only historical docs/plans (never source or manifests); build/typecheck/test PASS across the workspace.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(runtime): rewire demo-bank + examples onto @flowlet/runtime"
```

### Task 4: In-memory Store (threads, saved flowlets, audit, aggregate)

The automations sub-store already exists (`InMemoryAutomationStore` implements the frozen `AutomationStore`). This task adds the other three sub-stores and the `Store` aggregate. Style matches `InMemoryAutomationStore`: `Map` state, `opts.now` injectable clock, counter ids, Principal ownership via `tenantId::subject`.

**Files:**
- Create: `packages/flowlet-runtime/src/embedded/in-memory-store.ts`
- Test: `packages/flowlet-runtime/src/embedded/in-memory-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import type { Principal } from "@flowlet/core";
import { createInMemoryStore } from "./in-memory-store";

const scope: Principal = { tenantId: "t1", subject: "u1" };
const other: Principal = { tenantId: "t1", subject: "u2" };
const now = () => "2026-07-02T00:00:00.000Z";

describe("InMemoryThreadStore", () => {
  it("creates threads with store-owned id + timestamps and lists per scope", async () => {
    const store = createInMemoryStore({ now });
    const thread = await store.threads.create(scope, { title: "Spending" });
    expect(thread.id).toBeTruthy();
    expect(thread.createdAt).toBe(now());
    expect(thread.tenantId).toBe("t1");
    expect(await store.threads.list(scope)).toHaveLength(1);
    expect(await store.threads.list(other)).toHaveLength(0);
    expect(await store.threads.get(other, thread.id)).toBeUndefined();
  });

  it("appends and reads back messages in order", async () => {
    const store = createInMemoryStore({ now });
    const thread = await store.threads.create(scope);
    const msg = (id: string) => ({ id, role: "user", parts: [] }) as never;
    await store.threads.appendMessages(scope, thread.id, [msg("m1")]);
    await store.threads.appendMessages(scope, thread.id, [msg("m2")]);
    const messages = await store.threads.getMessages(scope, thread.id);
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(await store.threads.getMessages(other, thread.id)).toEqual([]);
  });

  it("rejects appends to a thread that does not exist in scope", async () => {
    const store = createInMemoryStore({ now });
    await expect(
      store.threads.appendMessages(scope, "nope", []),
    ).rejects.toThrow(/unknown thread/i);
  });
});

describe("InMemorySavedFlowletStore", () => {
  const draft = {
    name: "Late-night spend",
    pinned: false,
    uiTree: { kind: "component", id: "n1", name: "Text", props: {} } as never,
    query: { toolName: "get_transactions", input: { limit: 40 } },
    originatingPrompt: "show my late-night spending",
  };

  it("saves with store-owned identity and scopes reads/deletes", async () => {
    const store = createInMemoryStore({ now });
    const saved = await store.flowlets.save(scope, draft);
    expect(saved.id).toBeTruthy();
    expect(saved.createdAt).toBe(now());
    expect(await store.flowlets.get(scope, saved.id)).toEqual(saved);
    expect(await store.flowlets.get(other, saved.id)).toBeUndefined();
    await store.flowlets.delete(other, saved.id); // no-op outside scope
    expect(await store.flowlets.list(scope)).toHaveLength(1);
    await store.flowlets.delete(scope, saved.id);
    expect(await store.flowlets.list(scope)).toHaveLength(0);
  });
});

describe("InMemoryAuditLog", () => {
  it("appends and exposes events for tests (append-only)", async () => {
    const store = createInMemoryStore({ now });
    await store.audit.append({
      at: now(),
      principal: scope,
      kind: "approval",
      toolCallId: "call-1",
      decision: "approved",
    });
    expect(store.audit.events).toHaveLength(1);
    expect(store.audit.events[0]?.kind).toBe("approval");
  });
});

describe("createInMemoryStore", () => {
  it("aggregates all four frozen sub-stores", async () => {
    const store = createInMemoryStore({ now });
    const record = await store.automations.save(scope, {
      name: "snitch",
      status: "enabled",
      spec: {
        dslVersion: 1,
        name: "snitch",
        trigger: { source: "external", event: "transaction.created" },
        steps: [],
      },
    });
    expect(record.id).toBeTruthy();
    expect(await store.automations.list(other)).toHaveLength(0);
  });
});
```

(If the minimal `spec` literal fails `automationSpecSchema`, copy the smallest valid spec from `src/automations/schema.test.ts` — the store test only needs *a* valid spec, not a particular one.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flowlet/runtime test -- src/embedded/in-memory-store.test.ts`
Expected: FAIL — module `./in-memory-store` not found.

- [ ] **Step 3: Implement `in-memory-store.ts`**

```ts
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
```

(Check `@flowlet/core`'s index exports the seam types used above; they were exported by the contracts freeze — verify with grep and, if a name differs, match the frozen name, never redefine.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @flowlet/runtime test -- src/embedded/in-memory-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-runtime/src/embedded/in-memory-store.ts packages/flowlet-runtime/src/embedded/in-memory-store.test.ts
git commit -m "feat(runtime): in-memory Store seam (threads, saved flowlets, audit + aggregate)"
```

### Task 5: In-process CredentialBroker

Embedded semantics per the frozen seam doc: `authenticate` is a pass-through of the host-supplied Principal; `acquireGrant` returns the ambient identity as a short-lived token.

**Files:**
- Create: `packages/flowlet-runtime/src/embedded/in-process-credential-broker.ts`
- Test: `packages/flowlet-runtime/src/embedded/in-process-credential-broker.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { InProcessCredentialBroker } from "./in-process-credential-broker";

const nowMs = () => Date.parse("2026-07-02T00:00:00.000Z");

describe("InProcessCredentialBroker", () => {
  it("authenticates a Principal-shaped credential as a pass-through", async () => {
    const broker = new InProcessCredentialBroker({ nowMs });
    const principal = await broker.authenticate({ tenantId: "t1", subject: "u1" });
    expect(principal).toEqual({ tenantId: "t1", subject: "u1" });
  });

  it("preserves claims on the authenticated principal", async () => {
    const broker = new InProcessCredentialBroker({ nowMs });
    const principal = await broker.authenticate({
      tenantId: "t1",
      subject: "u1",
      claims: { name: "Yousef" },
    });
    expect(principal.claims).toEqual({ name: "Yousef" });
  });

  it("rejects a credential that is not Principal-shaped (fail closed)", async () => {
    const broker = new InProcessCredentialBroker({ nowMs });
    await expect(broker.authenticate("a-jwt-string")).rejects.toThrow(/principal/i);
    await expect(broker.authenticate({ tenantId: "t1" })).rejects.toThrow(/principal/i);
  });

  it("acquireGrant returns the ambient identity with the requested scopes and an expiry", async () => {
    const broker = new InProcessCredentialBroker({ nowMs, grantTtlMs: 60_000 });
    const grant = await broker.acquireGrant({
      principal: { tenantId: "t1", subject: "u1" },
      automationId: "auto-1",
      scopes: ["transactions:read"],
    });
    expect(grant.token).toBe("embedded:t1:u1:auto-1");
    expect(grant.scopes).toEqual(["transactions:read"]);
    expect(grant.expiresAt).toBe("2026-07-02T00:01:00.000Z");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flowlet/runtime test -- src/embedded/in-process-credential-broker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Embedded implementation of the frozen CredentialBroker seam: the host runs
 * the runtime in-process, so `authenticate` is a shape-checked pass-through of
 * the host-supplied Principal and `acquireGrant` returns the ambient identity
 * as a short-lived non-secret token (seam doc: "authenticate is a
 * pass-through, acquireGrant returns the ambient identity"). No JWT, no token
 * exchange — that is the cloud implementation.
 */
import type { BrokeredGrant, CredentialBroker, GrantRequest, Principal } from "@flowlet/core";

const DEFAULT_GRANT_TTL_MS = 15 * 60 * 1000;

function isPrincipal(value: unknown): value is Principal {
  if (value === null || typeof value !== "object") return false;
  const p = value as Partial<Principal>;
  return typeof p.tenantId === "string" && typeof p.subject === "string";
}

export interface InProcessCredentialBrokerConfig {
  nowMs?: () => number;
  grantTtlMs?: number;
}

export class InProcessCredentialBroker implements CredentialBroker {
  private readonly nowMs: () => number;
  private readonly grantTtlMs: number;

  constructor(config: InProcessCredentialBrokerConfig = {}) {
    this.nowMs = config.nowMs ?? Date.now;
    this.grantTtlMs = config.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
  }

  async authenticate(credential: unknown): Promise<Principal> {
    if (!isPrincipal(credential)) {
      throw new Error(
        "InProcessCredentialBroker.authenticate expects a Principal ({ tenantId, subject }) from the host",
      );
    }
    return credential;
  }

  async acquireGrant(request: GrantRequest): Promise<BrokeredGrant> {
    const { principal, automationId, scopes } = request;
    return {
      token: `embedded:${principal.tenantId}:${principal.subject}:${automationId}`,
      expiresAt: new Date(this.nowMs() + this.grantTtlMs).toISOString(),
      scopes: [...scopes],
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @flowlet/runtime test -- src/embedded/in-process-credential-broker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-runtime/src/embedded/in-process-credential-broker.*
git commit -m "feat(runtime): in-process CredentialBroker seam implementation"
```

### Task 6: In-process Executor

**Files:**
- Create: `packages/flowlet-runtime/src/embedded/in-process-executor.ts`
- Test: `packages/flowlet-runtime/src/embedded/in-process-executor.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "@flowlet/core";
import { InProcessExecutor } from "./in-process-executor";

const context: ExecutionContext = { principal: { tenantId: "t1", subject: "u1" } };

describe("InProcessExecutor", () => {
  it("runs a registered tool and returns its outcome", async () => {
    const executor = new InProcessExecutor({
      echo: async (input) => ({ ok: true, result: input }),
    });
    const outcome = await executor.execute(
      { toolCallId: "c1", toolName: "echo", input: { a: 1 } },
      context,
    );
    expect(outcome).toEqual({ ok: true, result: { a: 1 } });
  });

  it("preserves ok:true with an undefined result (never mis-narrows as error)", async () => {
    const executor = new InProcessExecutor({
      noop: async () => ({ ok: true, result: undefined }),
    });
    const outcome = await executor.execute(
      { toolCallId: "c1", toolName: "noop", input: {} },
      context,
    );
    expect(outcome.ok).toBe(true);
  });

  it("fails closed on an unknown tool", async () => {
    const executor = new InProcessExecutor({});
    const outcome = await executor.execute(
      { toolCallId: "c1", toolName: "missing", input: {} },
      context,
    );
    expect(outcome).toEqual({
      ok: false,
      error: { code: "unknown_tool", message: 'tool "missing" is not registered' },
    });
  });

  it("converts a thrown error into an error outcome (one crashed call, not a crashed host)", async () => {
    const executor = new InProcessExecutor({
      boom: async () => {
        throw new Error("kaboom");
      },
    });
    const outcome = await executor.execute(
      { toolCallId: "c1", toolName: "boom", input: {} },
      context,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("tool_error");
      expect(outcome.error.message).toContain("kaboom");
    }
  });

  it("passes the execution context (grant, signal) through to the tool", async () => {
    let seen: ExecutionContext | undefined;
    const executor = new InProcessExecutor({
      probe: async (_input, ctx) => {
        seen = ctx;
        return { ok: true, result: null };
      },
    });
    const grantCtx: ExecutionContext = {
      principal: context.principal,
      grant: { token: "embedded:t1:u1:auto-1", expiresAt: "2026-07-02T00:15:00.000Z", scopes: [] },
    };
    await executor.execute({ toolCallId: "c1", toolName: "probe", input: {} }, grantCtx);
    expect(seen?.grant?.token).toBe("embedded:t1:u1:auto-1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flowlet/runtime test -- src/embedded/in-process-executor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Embedded implementation of the frozen Executor seam: tool calls run
 * in-process against host-registered functions (architecture Decision 2's
 * embedded row). Policy has already evaluated the call before it reaches any
 * executor; this seam only runs it. Fail-closed: unknown tools and thrown
 * errors both resolve to `{ ok: false }` outcomes — an executor never throws.
 */
import type {
  ExecutionContext,
  Executor,
  ToolCallOutcome,
  ToolCallRequest,
} from "@flowlet/core";

export type InProcessToolFn = (
  input: unknown,
  context: ExecutionContext,
) => Promise<ToolCallOutcome>;

export class InProcessExecutor implements Executor {
  constructor(private readonly tools: Record<string, InProcessToolFn>) {}

  async execute(call: ToolCallRequest, context: ExecutionContext): Promise<ToolCallOutcome> {
    const tool = this.tools[call.toolName];
    if (!tool) {
      return {
        ok: false,
        error: { code: "unknown_tool", message: `tool "${call.toolName}" is not registered` },
      };
    }
    try {
      return await tool(call.input, context);
    } catch (err) {
      return {
        ok: false,
        error: { code: "tool_error", message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @flowlet/runtime test -- src/embedded/in-process-executor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-runtime/src/embedded/in-process-executor.*
git commit -m "feat(runtime): in-process Executor seam implementation"
```

### Task 7: In-app Channels

**Files:**
- Create: `packages/flowlet-runtime/src/embedded/in-app-channels.ts`
- Test: `packages/flowlet-runtime/src/embedded/in-app-channels.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import type { OutboundMessage } from "@flowlet/core";
import { InAppChannels } from "./in-app-channels";

const message: OutboundMessage = {
  channel: "in-app",
  principal: { tenantId: "t1", subject: "u1" },
  text: "Your automation fired",
  threadId: "thread-1",
};

describe("InAppChannels", () => {
  it("records in-app deliveries and invokes the host callback", async () => {
    const seen: OutboundMessage[] = [];
    const channels = new InAppChannels({ onDeliver: (m) => seen.push(m) });
    await channels.deliver(message);
    expect(channels.delivered).toEqual([message]);
    expect(seen).toEqual([message]);
  });

  it("rejects non in-app channels (embedded is in-app only, fail closed)", async () => {
    const channels = new InAppChannels();
    await expect(channels.deliver({ ...message, channel: "sms" })).rejects.toThrow(/in-app/i);
    expect(channels.delivered).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flowlet/runtime test -- src/embedded/in-app-channels.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Embedded implementation of the frozen Channels seam: in-app only
 * (architecture Decision 1's embedded row — SMS/voice are cloud transports).
 * Deliveries are recorded for tests and handed to an optional host callback;
 * any non in-app channel is rejected rather than silently dropped.
 */
import type { Channels, OutboundMessage } from "@flowlet/core";

export interface InAppChannelsConfig {
  onDeliver?: (message: OutboundMessage) => void;
}

export class InAppChannels implements Channels {
  readonly delivered: OutboundMessage[] = [];

  constructor(private readonly config: InAppChannelsConfig = {}) {}

  async deliver(message: OutboundMessage): Promise<void> {
    if (message.channel !== "in-app") {
      throw new Error(
        `InAppChannels only delivers "in-app" messages; got "${message.channel}" (embedded mode has no SMS/voice transport)`,
      );
    }
    this.delivered.push(message);
    this.config.onDeliver?.(message);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @flowlet/runtime test -- src/embedded/in-app-channels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-runtime/src/embedded/in-app-channels.*
git commit -m "feat(runtime): in-app Channels seam implementation"
```

### Task 8: Embedded barrel + public exports

**Files:**
- Create: `packages/flowlet-runtime/src/embedded/index.ts`
- Modify: `packages/flowlet-runtime/src/index.ts` (append exports)

- [ ] **Step 1: Write the barrel**

```ts
/**
 * Embedded implementations of all five frozen seams, for tests and in-process
 * (embedded) deployments. The Scheduler's embedded implementation is
 * InProcessScheduler (src/automations/in-process-scheduler.ts, ENG-188) and
 * the automations sub-store is InMemoryAutomationStore (src/automations/
 * store.ts) — both re-exported here so this barrel covers the full set.
 */
export {
  createInMemoryStore,
  InMemoryAuditLog,
  InMemorySavedFlowletStore,
  InMemoryThreadStore,
  type InMemoryStore,
} from "./in-memory-store";
export {
  InProcessCredentialBroker,
  type InProcessCredentialBrokerConfig,
} from "./in-process-credential-broker";
export { InProcessExecutor, type InProcessToolFn } from "./in-process-executor";
export { InAppChannels, type InAppChannelsConfig } from "./in-app-channels";
export { InMemoryAutomationStore } from "../automations/store";
export { InProcessScheduler } from "../automations/in-process-scheduler";
```

- [ ] **Step 2: Export from the package index**

Append to `packages/flowlet-runtime/src/index.ts` (note: `InMemoryAutomationStore` and `InProcessScheduler` are already exported via `export * from "./automations"`, so re-export ONLY the new embedded modules here to avoid duplicate-export errors):

```ts
// Embedded seam implementations (in-memory/in-process) for tests and
// embedded deployments — the other half of architecture Decision 1.
export {
  createInMemoryStore,
  InMemoryAuditLog,
  InMemorySavedFlowletStore,
  InMemoryThreadStore,
  type InMemoryStore,
} from "./embedded/in-memory-store";
export {
  InProcessCredentialBroker,
  type InProcessCredentialBrokerConfig,
} from "./embedded/in-process-credential-broker";
export { InProcessExecutor, type InProcessToolFn } from "./embedded/in-process-executor";
export { InAppChannels, type InAppChannelsConfig } from "./embedded/in-app-channels";
```

(If `export * from "./embedded/index"` would collide with the automations barrel, keep the explicit list above — that is why the index does not `export *` the barrel.)

- [ ] **Step 3: Verify build + full package tests**

```bash
pnpm --filter @flowlet/runtime build && pnpm --filter @flowlet/runtime test
```

Expected: PASS, no duplicate-export diagnostics.

- [ ] **Step 4: Commit**

```bash
git add packages/flowlet-runtime/src/embedded/index.ts packages/flowlet-runtime/src/index.ts
git commit -m "feat(runtime): embedded seam barrel + public exports"
```

### Task 9: Dependency-lint guard (the permanent embedded-mode CI gate)

A vitest test inside `@flowlet/runtime` so it runs on every `pnpm test` forever. Two layers: (a) an ALLOWLIST over `package.json` runtime dependencies — any new dep fails until consciously added; (b) an import scan over `src/` banning db/queue/http-server modules and Node server builtins.

**Files:**
- Create: `packages/flowlet-runtime/src/dependency-guard.test.ts`

- [ ] **Step 1: Write the guard test (it must PASS immediately — the "failing test" here is proven by mutation in Step 3)**

```ts
/**
 * The embedded-mode architectural guarantee (architecture Decision 1), kept
 * honest in CI forever: @flowlet/runtime never imports a database, queue, or
 * HTTP server. Two layers:
 *
 *  1. package.json runtime dependencies are ALLOWLISTED — adding any new
 *     dependency fails this test until it is consciously reviewed and added.
 *  2. every src/ import is scanned against a denylist of cloud concerns
 *     (db drivers, queues, http servers, Node server builtins).
 *
 * If you are here because this test failed: the fix is almost never "add it
 * to the allowlist". Cloud concerns belong in apps/cloud behind a seam.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PKG_ROOT = join(__dirname, "..");

/** Every runtime dependency, consciously reviewed. Keep alphabetical. */
const ALLOWED_DEPENDENCIES = [
  "@ai-sdk/anthropic",
  "@ai-sdk/mcp",
  "@ai-sdk/provider",
  "@composio/core",
  "@composio/vercel",
  "@flowlet/core",
  "ai",
  "croner",
  "jsonata",
  "sucrase",
  "zod",
];

/** Cloud concerns that must never appear anywhere near this package. */
const FORBIDDEN_MODULES = [
  // databases / ORMs
  "pg", "postgres", "mysql", "mysql2", "sqlite3", "better-sqlite3", "libsql",
  "@prisma/client", "prisma", "drizzle-orm", "knex", "typeorm", "sequelize",
  "mongodb", "mongoose", "redis", "ioredis",
  // queues / job runners
  "pg-boss", "bullmq", "bull", "bee-queue", "amqplib", "kafkajs", "agenda",
  // http servers / frameworks
  "express", "fastify", "koa", "hono", "@hapi/hapi", "restify", "next",
  // Node server builtins
  "http", "https", "net", "tls", "http2", "dgram", "cluster",
  "node:http", "node:https", "node:net", "node:tls", "node:http2", "node:dgram", "node:cluster",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** import/export-from/require specifiers in a source file. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  return specifiers;
}

/** "pg/lib/foo" and "node:http" both resolve to their forbidden root. */
function moduleRoot(specifier: string): string {
  if (specifier.startsWith(".")) return specifier;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

describe("dependency guard: @flowlet/runtime is portable (Decision 1)", () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it("runtime dependencies are exactly the reviewed allowlist", () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(
      [...ALLOWED_DEPENDENCIES].sort(),
    );
  });

  it("no dependency or devDependency is a db, queue, or http server", () => {
    const all = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    const offending = all.filter((name) => FORBIDDEN_MODULES.includes(name));
    expect(offending).toEqual([]);
  });

  it("no src/ file imports a db, queue, http server, or Node server builtin", () => {
    const offending: string[] = [];
    for (const file of sourceFiles(join(PKG_ROOT, "src"))) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (FORBIDDEN_MODULES.includes(moduleRoot(specifier))) {
          offending.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — must pass on the clean tree**

Run: `pnpm --filter @flowlet/runtime test -- src/dependency-guard.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Mutation-check the guard actually bites (all three layers)**

1. Add `"pg": "^8.0.0"` to `packages/flowlet-runtime/package.json` dependencies → run the test → expect the allowlist test AND the forbidden-deps test to FAIL. Revert.
2. Add `import "node:http";` to the top of `packages/flowlet-runtime/src/errors.ts` → run → expect the import-scan test to FAIL. Revert.
3. Re-run the guard test → PASS again, `git status` clean except the new test file.

- [ ] **Step 4: Commit**

```bash
git add packages/flowlet-runtime/src/dependency-guard.test.ts
git commit -m "test(runtime): dependency-lint guard — no db/queue/http-server, allowlisted deps (Decision 1 CI gate)"
```

### Task 10: Docs sync

**Files:**
- Modify: `docs/contracts/seams.md` (embedded implementations now live in @flowlet/runtime)
- Modify: `CLAUDE.md` only if it references flowlet-agent (grep first; currently it does not)
- Check: root `README.md` for flowlet-agent references

- [ ] **Step 1: Update seams.md**

In `docs/contracts/seams.md` line 3, change:

```markdown
The portable runtime (architecture Decision 1) never imports a database, queue, or HTTP server — it depends on five injected seams. Interfaces live in `packages/flowlet-core/src/seams/`; demo-bank's in-process implementations keep the embedded guarantee honest in CI.
```

to:

```markdown
The portable runtime (`@flowlet/runtime`, architecture Decision 1) never imports a database, queue, or HTTP server — it depends on five injected seams. Interfaces live in `packages/flowlet-core/src/seams/`; embedded (in-memory/in-process) implementations of all five ship in `@flowlet/runtime`'s `embedded` module, and the runtime's dependency-guard test plus demo-bank keep the embedded guarantee honest in CI.
```

- [ ] **Step 2: Sweep remaining doc references**

```bash
grep -rn "flowlet-agent\|@flowlet/agent" README.md CLAUDE.md docs/contracts docs/PRD.md 2>/dev/null
```

Update any live-doc hit to the runtime name. Point-in-time specs/plans under `docs/superpowers/` stay as-is (historical records).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: sync seam contracts + references for the runtime carve-out"
```

### Task 11: Full verification (build, typecheck, test, lint, browser)

- [ ] **Step 1: Workspace gates**

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

Expected: all green.

- [ ] **Step 2: Browser gate — demo-bank behaves identically on the carved runtime**

```bash
pnpm demo
```

Then in a real browser: open the demo, run one chat turn that renders UI (e.g. "show my spending by category"), one approval-gated action, and confirm the automations flow still lists/fires (poll route ticks). Screenshot each for the PR. Zero behavior change is the bar.

- [ ] **Step 3: Update the Orca worktree comment**

```bash
orca worktree set --worktree active --comment "runtime carve-out: verified green (build/typecheck/test/lint + browser), opening PR"
```

### Task 12: PR + dual-review pipeline

- [ ] **Step 1: Push and open the PR (never merge without the pipeline)**

PR body must include: the absorb-vs-compat decision + rationale (flagged for Yousef), the pure-rename first commit note for eng-184's rebase (list the moved prompt-bearing files: `engine.ts`, `render-view-tool.ts`, `compile-component.ts`), browser screenshots, and the dependency-guard mutation-check evidence.

- [ ] **Step 2: Run the standing dual-review pipeline (fresh Codex + Opus) on the PR, triage findings, fix real ones, then self-merge per the standing pipeline.**
