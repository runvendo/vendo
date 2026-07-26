# ENG-359 Knowledge Wire Protocol Draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draft the knowledge wire protocol — the HTTP profile of the frozen `KnowledgeAdapter` contract, shared by the cloud client (ENG-364) and the BYO HTTP template (ENG-365) — as executable core types/schemas/helpers, plus the two inherited behavioral conformance cases, all green on the memory stub.

**Architecture:** One new core module `packages/core/src/knowledge-wire.ts` (format constant, mount-relative path table, request/response DTOs reusing the frozen knowledge schemas, the standard `{error:{code,message}}` envelope with the wire's status table, and two pure error-mapping helpers that both sides of ENG-364 consume). Conformance growth lands in the existing `conformance/knowledge.ts` suite. No server, no client — those are Stage 2; this freezes what they will speak.

**Tech Stack:** TypeScript 5.6, zod ^3.25 (core's only dependency — add nothing), vitest 2.1, ESM with `.js` import suffixes.

## Global Constraints

- Working tree: `C:\Vendo\New_Vendo_Workspace\vendo` on branch `amr/eng-359-s0-wire-protocol-draft-behavioral-conformance-cases-vs-stub` (in-place branch — no worktrees). Never commit to `main`.
- Run all pnpm commands from PowerShell with `$env:PATH = "C:\Users\kille\bin;$env:PATH"` prepended (pnpm.exe lives there; Git Bash's GNU tar breaks the packaging e2e).
- Only `packages/core` changes (plus this plan file and a changeset). `@vendoai/core` imports NOTHING from other `@vendoai/*` packages.
- Schema conventions (copy exactly): interface first, then `export const xSchema = z.object({...}).passthrough() satisfies z.ZodType<X>;` — `.passthrough()` on every object schema, `satisfies` not `as`.
- Doc comments cite the decision record: `/** Knowledge design v2 (2026-07-22) R<n> ... */` — plus, for wire decisions made this week, `(decision 2026-07-24)`.
- All imports use relative paths with `.js` suffix; tests import from `./index.js`, not sibling module files.
- Wire doctrine (verified precedents, do not deviate): error envelope is exactly `{ "error": { "code", "message" } }` mirroring `packages/vendo/src/wire/shared.ts`; status mapping mirrors its `STATUS_BY_CODE` (validation 400, not-found 404, blocked 403, conflict 409, cloud-required 402, sandbox-unavailable 501, not-implemented 501); RPC verbs are POST-JSON (the `hostedStore` method-for-method precedent), discovery is GET; format constants use the `"vendo/<name>@<n>"` shape; custom headers, if ever needed, are lowercase `x-vendo-*`; **the wire carries NO tenant selector of any kind** (R5 invariant 1 — tenancy is derived server-side by the mounting surface); the protocol is auth-agnostic (the mounting surface owns auth: cloud = `Authorization: Bearer vnd_…` at `<console>/api/v1/knowledge`, BYO = the `httpKnowledge` auth config).
- Commit messages: `feat(core): …` / `test(core): …` / `chore(core): …`, each ending with the line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- The two-adapter decision (2026-07-24) means nothing Agentset-specific may appear in this module — the protocol must read backend-neutral.

---

### Task 1: The wire-protocol module — format, paths, DTOs, error envelope, helpers

**Files:**
- Create: `packages/core/src/knowledge-wire.ts`
- Create: `packages/core/src/knowledge-wire.test.ts`
- Modify: `packages/core/src/index.ts` (add one export line between `export * from "./knowledge.js";` and `export * from "./kit/index.js";`)

**Interfaces:**
- Consumes (from `./knowledge.js`, all frozen in ENG-358): `knowledgeDocSchema`, `knowledgeQuerySchema`, `knowledgeRefSchema`, `knowledgeSearchResultSchema`, `knowledgeFetchResultSchema`, `knowledgeStatusSchema`, `knowledgePostureSchema` and their types; (from `./errors.js`): `VendoError`, `VendoErrorCode`, `vendoErrorCodeSchema`, `safeErrorMessage`.
- Produces (ENG-364/365 rely on these exact names): `VENDO_KNOWLEDGE_WIRE_FORMAT`, `KNOWLEDGE_WIRE_PATHS`, `KnowledgeWireSearchRequest`/`knowledgeWireSearchRequestSchema`, `KnowledgeWireFetchRequest`/`knowledgeWireFetchRequestSchema`, `KnowledgeWireUpsertRequest`/`knowledgeWireUpsertRequestSchema`, `KnowledgeWireRemoveRequest`/`knowledgeWireRemoveRequestSchema`, `KnowledgeWireStatus`/`knowledgeWireStatusSchema`, `KnowledgeWireError`/`knowledgeWireErrorSchema`, `KNOWLEDGE_WIRE_STATUS_BY_CODE`, `knowledgeWireErrorBody(error: VendoError): { status: number; body: KnowledgeWireError }`, `parseKnowledgeWireError(status: number, body: unknown): VendoError`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/knowledge-wire.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_WIRE_PATHS,
  KNOWLEDGE_WIRE_STATUS_BY_CODE,
  VENDO_KNOWLEDGE_WIRE_FORMAT,
  VendoError,
  knowledgeWireErrorBody,
  knowledgeWireErrorSchema,
  knowledgeWireFetchRequestSchema,
  knowledgeWireRemoveRequestSchema,
  knowledgeWireSearchRequestSchema,
  knowledgeWireStatusSchema,
  knowledgeWireUpsertRequestSchema,
  parseKnowledgeWireError,
  type KnowledgeWireStatus,
} from "./index.js";

describe("vendo/knowledge-wire@1", () => {
  it("exposes the format constant and the five mount-relative paths", () => {
    expect(VENDO_KNOWLEDGE_WIRE_FORMAT).toBe("vendo/knowledge-wire@1");
    expect(KNOWLEDGE_WIRE_PATHS).toEqual({
      search: "/search",
      fetch: "/fetch",
      upsert: "/upsert",
      remove: "/remove",
      status: "/status",
    });
  });

  it("parses the four request DTOs and rejects tenant-smelling extras only via schema rules", () => {
    expect(knowledgeWireSearchRequestSchema.parse({
      query: { text: "refunds", intent: "chat" },
      includeInternal: true,
    }).includeInternal).toBe(true);
    expect(knowledgeWireSearchRequestSchema.safeParse({ query: { text: "" } }).success).toBe(false);
    expect(knowledgeWireFetchRequestSchema.parse({ ref: { docId: "doc_1", chunkId: "doc_1#2" } }).ref.docId).toBe("doc_1");
    expect(knowledgeWireFetchRequestSchema.safeParse({ ref: { chunkId: "no-doc-id" } }).success).toBe(false);
    expect(knowledgeWireUpsertRequestSchema.parse({
      docs: [{ id: "d1", kind: "docs", visibility: "public", title: "T", text: "body", source: "s.md" }],
    }).docs).toHaveLength(1);
    expect(knowledgeWireRemoveRequestSchema.safeParse({ docIds: [""] }).success).toBe(false);
  });

  it("status doubles as the discovery handshake: format + posture + counts", () => {
    const status: KnowledgeWireStatus = {
      format: VENDO_KNOWLEDGE_WIRE_FORMAT,
      posture: { fetch: true, write: true, visibility: "enforced" },
      status: { docs: 3, byKind: { docs: 2, glossary: 1 } },
    };
    expect(knowledgeWireStatusSchema.parse(status).posture.write).toBe(true);
    expect(knowledgeWireStatusSchema.safeParse({ ...status, format: "vendo/knowledge-wire@2" }).success).toBe(false);
  });

  it("maps every VendoError code to the wire status table and back", () => {
    const { status, body } = knowledgeWireErrorBody(new VendoError("not-found", "unknown ref"));
    expect(status).toBe(404);
    expect(knowledgeWireErrorSchema.parse(body).error.code).toBe("not-found");
    const roundTripped = parseKnowledgeWireError(status, body);
    expect(roundTripped).toBeInstanceOf(VendoError);
    expect(roundTripped.code).toBe("not-found");
    expect(roundTripped.message).toBe("unknown ref");
    expect(KNOWLEDGE_WIRE_STATUS_BY_CODE["cloud-required"]).toBe(402);
    expect(KNOWLEDGE_WIRE_STATUS_BY_CODE["validation"]).toBe(400);
  });

  it("parseKnowledgeWireError: enveloped code wins, bare statuses map, junk degrades honestly", () => {
    expect(parseKnowledgeWireError(400, { error: { code: "conflict", message: "id taken" } }).code).toBe("conflict");
    expect(parseKnowledgeWireError(404, "not json at all").code).toBe("not-found");
    expect(parseKnowledgeWireError(402, undefined).code).toBe("cloud-required");
    expect(parseKnowledgeWireError(500, { error: { code: "not-a-real-code", message: "?" } }).code).toBe("not-implemented");
    expect(parseKnowledgeWireError(503, null).code).toBe("not-implemented");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @vendoai/core exec vitest run src/knowledge-wire.test.ts`
Expected: FAIL — the new exports do not resolve.

- [ ] **Step 3: Write the module**

Create `packages/core/src/knowledge-wire.ts`:

```typescript
import { z } from "zod";
import { VendoError, safeErrorMessage, vendoErrorCodeSchema, type VendoErrorCode } from "./errors.js";
import {
  knowledgeDocSchema,
  knowledgePostureSchema,
  knowledgeQuerySchema,
  knowledgeRefSchema,
  knowledgeStatusSchema,
  type KnowledgeDoc,
  type KnowledgePosture,
  type KnowledgeQuery,
  type KnowledgeRef,
  type KnowledgeStatus,
} from "./knowledge.js";

/** Knowledge design v2 (2026-07-22) R2 — the wire protocol version tag. The
    HTTP profile of the KnowledgeAdapter contract, shared verbatim by the
    cloud client and the BYO `httpKnowledge` template (decision 2026-07-24:
    two cloud backend adapters sit BEHIND this protocol — nothing
    backend-specific may appear on the wire). */
export const VENDO_KNOWLEDGE_WIRE_FORMAT = "vendo/knowledge-wire@1" as const;

/** Mount-relative endpoint paths. The mounting surface owns the prefix
    (cloud: `<console>/api/v1/knowledge`; BYO: the `httpKnowledge` url) and
    owns auth — the protocol itself is auth-agnostic and carries NO tenant
    selector of any kind (R5 invariant 1: tenancy derives server-side).
    Verbs: the four adapter operations are POST-JSON RPC; `status` is GET and
    doubles as the discovery handshake (format + posture). */
export const KNOWLEDGE_WIRE_PATHS = {
  search: "/search",
  fetch: "/fetch",
  upsert: "/upsert",
  remove: "/remove",
  status: "/status",
} as const;

/** POST /search — the wire form of `search(query, ctx)`. `includeInternal`
    is legitimate on the wire ONLY because every mounting surface is a
    key-authed, host-trusted hop (R5, KB-COV-7): the OSS composition enforces
    the trusted-caller rule BEFORE the request leaves the process, and the
    server trusts the flag because the bearer key already proves the caller
    is host code, never an end user. */
export interface KnowledgeWireSearchRequest {
  query: KnowledgeQuery;
  includeInternal?: boolean;
}

export const knowledgeWireSearchRequestSchema = z.object({
  query: knowledgeQuerySchema,
  includeInternal: z.boolean().optional(),
}).passthrough() satisfies z.ZodType<KnowledgeWireSearchRequest>;

/** POST /fetch — the wire form of `fetch(ref, ctx)`. A missing or
    internal-invisible ref is answered with the 404 error envelope, which
    clients translate back to the contract's `null` (a ref is not a
    capability — internal docs behave as unknown without `includeInternal`).
    Response body on 200: a `KnowledgeFetchResult` (see knowledge.js). */
export interface KnowledgeWireFetchRequest {
  ref: KnowledgeRef;
  includeInternal?: boolean;
}

export const knowledgeWireFetchRequestSchema = z.object({
  ref: knowledgeRefSchema,
  includeInternal: z.boolean().optional(),
}).passthrough() satisfies z.ZodType<KnowledgeWireFetchRequest>;

/** POST /upsert — document-level, engines own chunking. The 200 response is
    an empty JSON object and MUST NOT be sent before the documents are
    searchable (the contract's upsert-resolves-when-searchable semantic —
    backends with asynchronous indexing await it server-side). */
export interface KnowledgeWireUpsertRequest {
  docs: KnowledgeDoc[];
}

export const knowledgeWireUpsertRequestSchema = z.object({
  docs: z.array(knowledgeDocSchema),
}).passthrough() satisfies z.ZodType<KnowledgeWireUpsertRequest>;

/** POST /remove — unknown ids resolve as no-ops; 200 is an empty object. */
export interface KnowledgeWireRemoveRequest {
  docIds: string[];
}

export const knowledgeWireRemoveRequestSchema = z.object({
  docIds: z.array(z.string().min(1)),
}).passthrough() satisfies z.ZodType<KnowledgeWireRemoveRequest>;

/** GET /status — the discovery handshake. Clients learn the protocol
    version (`format`), the declared capability posture, and the corpus
    counts in one round-trip; the posture here is the same declaration the
    conformance suite verifies (knowledge design v2 R2). */
export interface KnowledgeWireStatus {
  format: typeof VENDO_KNOWLEDGE_WIRE_FORMAT;
  posture: KnowledgePosture;
  status: KnowledgeStatus;
}

export const knowledgeWireStatusSchema = z.object({
  format: z.literal(VENDO_KNOWLEDGE_WIRE_FORMAT),
  posture: knowledgePostureSchema,
  status: knowledgeStatusSchema,
}).passthrough() satisfies z.ZodType<KnowledgeWireStatus>;

/** The standard wire error envelope — byte-identical to the umbrella wire's
    (`packages/vendo/src/wire/shared.ts`): `{ error: { code, message } }`. */
export interface KnowledgeWireError {
  error: {
    code: VendoErrorCode;
    message: string;
  };
}

export const knowledgeWireErrorSchema = z.object({
  error: z.object({
    code: vendoErrorCodeSchema,
    message: z.string(),
  }).passthrough(),
}).passthrough() satisfies z.ZodType<KnowledgeWireError>;

/** Mirrors the umbrella wire's STATUS_BY_CODE so the two surfaces never
    diverge; core cannot import it (layering — core depends on nothing). */
export const KNOWLEDGE_WIRE_STATUS_BY_CODE: Record<VendoErrorCode, number> = {
  validation: 400,
  "not-found": 404,
  blocked: 403,
  conflict: 409,
  "cloud-required": 402,
  "sandbox-unavailable": 501,
  "not-implemented": 501,
};

const STATUS_TO_CODE: Record<number, VendoErrorCode> = {
  400: "validation",
  402: "cloud-required",
  403: "blocked",
  404: "not-found",
  409: "conflict",
};

/** Server half: one VendoError → the enveloped body + HTTP status. */
export function knowledgeWireErrorBody(error: VendoError): { status: number; body: KnowledgeWireError } {
  return {
    status: KNOWLEDGE_WIRE_STATUS_BY_CODE[error.code],
    body: { error: { code: error.code, message: safeErrorMessage(error) } },
  };
}

/** Client half: a non-2xx response → VendoError. An enveloped wire-legal
    code wins over the bare status; recognized statuses map through
    STATUS_TO_CODE; anything else degrades to "not-implemented" (never blame
    the caller with "validation" for a server-shaped failure). Client-specific
    tails — e.g. the cloud client folding bare 401 into "cloud-required" —
    belong to the client (ENG-364), not the protocol. */
export function parseKnowledgeWireError(status: number, body: unknown): VendoError {
  const parsed = knowledgeWireErrorSchema.safeParse(body);
  if (parsed.success) {
    return new VendoError(parsed.data.error.code, parsed.data.error.message);
  }
  const code = STATUS_TO_CODE[status];
  if (code !== undefined) {
    return new VendoError(code, `knowledge wire request failed with HTTP ${status}`);
  }
  return new VendoError("not-implemented", `knowledge wire request failed with HTTP ${status}`);
}
```

Then add the export to `packages/core/src/index.ts`, directly after the `export * from "./knowledge.js";` line:

```typescript
export * from "./knowledge-wire.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @vendoai/core exec vitest run src/knowledge-wire.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/knowledge-wire.ts packages/core/src/knowledge-wire.test.ts packages/core/src/index.ts
git commit -m "feat(core): draft the knowledge wire protocol — vendo/knowledge-wire@1 (ENG-359)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Behavioral conformance growth — fetch-visibility + real limit truncation

**Files:**
- Modify: `packages/core/src/conformance/knowledge.ts` (append two cases inside `knowledgeAdapterConformance`)
- Modify: `packages/core/src/conformance/knowledge.test.ts` (two regression adapters)

**Interfaces:**
- Consumes: the existing kit internals — `adapterCase`, `seed`, `ctx`, `assert`, `assertParses`, `knowledgeFetchResultSchema`, `opts.posture` — and `memoryKnowledgeAdapter` in the test.
- Produces: two new suite cases named `"R5 — fetch treats internal refs as unknown for default contexts"` and `"R3 — limit truncates a multi-hit result to a prefix"`. No new exports (the contract-coverage inventory is untouched).

- [ ] **Step 1: Write the failing regression tests**

In `packages/core/src/conformance/knowledge.test.ts`, append inside the top-level `describe`, after the "limited search that swaps in a different doc" test:

```typescript
  it("a fetch that leaks internal docs to default contexts fails conformance", async () => {
    const inner = memoryKnowledgeAdapter();
    const leakyFetch: KnowledgeAdapter = {
      posture: { fetch: true, write: true, visibility: "enforced" },
      search: (query, searchCtx) => inner.search(query, searchCtx),
      fetch: (ref) => inner.fetch!(ref, { principal: { kind: "user", subject: "leak" }, includeInternal: true }),
      upsert: (docs) => inner.upsert!(docs),
      remove: (docIds) => inner.remove!(docIds),
      status: () => inner.status(),
    };
    const report = await runConformance(knowledgeAdapterConformance({
      makeAdapter: async () => ({ adapter: leakyFetch }),
      posture: { fetch: true, write: true, visibility: "enforced" },
    }));
    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.name).join("\n")).toContain("fetch");
  });

  it("a search that silently caps multi-hit results fails conformance", async () => {
    const inner = memoryKnowledgeAdapter();
    const cappedSearch: KnowledgeAdapter = {
      posture: { fetch: true, write: true, visibility: "enforced" },
      search: async (query, searchCtx) => {
        const result = await inner.search(query, searchCtx);
        return { hits: result.hits.slice(0, 1) };
      },
      fetch: (ref, fetchCtx) => inner.fetch!(ref, fetchCtx),
      upsert: (docs) => inner.upsert!(docs),
      remove: (docIds) => inner.remove!(docIds),
      status: () => inner.status(),
    };
    const report = await runConformance(knowledgeAdapterConformance({
      makeAdapter: async () => ({ adapter: cappedSearch }),
      posture: { fetch: true, write: true, visibility: "enforced" },
    }));
    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.name).join("\n")).toContain("limit");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @vendoai/core exec vitest run src/conformance/knowledge.test.ts`
Expected: the two new tests FAIL (both adversarial adapters currently pass the suite — the cases that would catch them do not exist yet); all pre-existing tests PASS.

- [ ] **Step 3: Add the two conformance cases**

In `packages/core/src/conformance/knowledge.ts`:

(a) Inside the `if (opts.posture.visibility === "enforced")` block, after the existing includeInternal case, add — note it is additionally gated on `opts.posture.fetch`:

```typescript
    );
    if (opts.posture.fetch) {
      cases.push(adapterCase("R5 — fetch treats internal refs as unknown for default contexts", async (adapter) => {
        const trusted = await adapter.search({ text: seed.internal.title }, { ...ctx, includeInternal: true });
        const internalHit = trusted.hits.find((hit) => hit.ref.docId === seed.internal.id);
        assert(internalHit !== undefined, "includeInternal search did not surface the seeded internal doc — fetch visibility cannot be exercised");
        assert(await adapter.fetch?.(internalHit.ref, ctx) === null, "fetch leaked an internal doc to a default context — a ref is not a capability");
        const fetched = await adapter.fetch?.(internalHit.ref, { ...ctx, includeInternal: true });
        assert(fetched !== null && fetched !== undefined, "fetch denied an internal ref to a trusted includeInternal context");
        assertParses(knowledgeFetchResultSchema, fetched, "trusted internal fetch result is invalid");
      }));
    }
```

The existing `cases.push(` for the two visibility cases currently ends with `);` — restructure minimally so the new `if (opts.posture.fetch)` block sits INSIDE the `visibility === "enforced"` block, after that `);`.

(b) Inside the `if (opts.posture.write)` block, after the upsert/remove round-trip case, add:

```typescript
    cases.push(adapterCase("R3 — limit truncates a multi-hit result to a prefix", async (adapter) => {
      const sibling: KnowledgeDoc = {
        id: "doc_conformance_public_sibling",
        kind: "docs",
        visibility: "public",
        title: `${seed.public.title} addendum`,
        text: "Conformance sibling content for truncation.",
        source: "conformance/refunds-addendum.md",
      };
      await adapter.upsert?.([sibling]);
      try {
        const unlimited = await adapter.search({ text: seed.public.title }, ctx);
        assert(unlimited.hits.length >= 2, "seeding a sibling doc did not produce a multi-hit result — truncation cannot be exercised");
        const limited = await adapter.search({ text: seed.public.title, limit: 1 }, ctx);
        assert(limited.hits.length === 1, "limit: 1 did not truncate the multi-hit result to one hit");
        assert(limited.hits[0]!.ref.docId === unlimited.hits[0]!.ref.docId, "limit changed the ranking — the limited top hit differs from the unlimited top hit");
      } finally {
        await adapter.remove?.([sibling.id]);
      }
    }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @vendoai/core exec vitest run src/conformance/knowledge.test.ts src/conformance/memory-knowledge.test.ts`
Expected: PASS — both regression tests now fail their adversarial adapters, the memory stub passes the grown suite, and the public-only name check still passes (the new fetch case name contains "internal" and is correctly confined to the enforced branch).

- [ ] **Step 5: Run the whole core suite (regression sweep)**

Run: `pnpm --filter @vendoai/core build; if ($?) { pnpm --filter @vendoai/core test }`
Expected: PASS — all pre-existing tests plus the additions (previous full-suite count was 637; this task adds 2 mount-suite cases + 2 regression tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/conformance/knowledge.ts packages/core/src/conformance/knowledge.test.ts
git commit -m "test(core): grow knowledge conformance — fetch-side visibility + real limit truncation (ENG-359)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Changeset, full gate, plan commit

**Files:**
- Create: `.changeset/knowledge-wire-protocol.md`
- Create (already on disk, commit as-is): `docs/superpowers/plans/2026-07-24-eng-359-knowledge-wire-protocol.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a PR-ready branch.

- [ ] **Step 1: Write the changeset**

Create `.changeset/knowledge-wire-protocol.md`:

```markdown
---
"@vendoai/core": minor
---

Draft the knowledge wire protocol (`vendo/knowledge-wire@1`): the HTTP profile of the `KnowledgeAdapter` contract — mount-relative endpoint paths, request/response schemas, the standard error envelope with its status table, and pure error-mapping helpers — plus two new behavioral conformance cases (fetch-side visibility, real limit truncation).
```

- [ ] **Step 2: Run the full repo gate**

From PowerShell (with the PATH prepend), run separately, in order — the repo's own turbo binary is broken on this machine, so use turbo 2.5.8:
```
npx -y turbo@2.5.8 run build --concurrency=4
npx -y turbo@2.5.8 run test --concurrency=4
npx -y turbo@2.5.8 run typecheck --concurrency=4
node scripts/dependency-guard.mjs
node scripts/portability-gate.mjs
npx -y turbo@2.5.8 run lint --concurrency=4
```
Expected: all green EXCEPT `@vendoai/engine#test`, whose `sdk-seam.test.ts` fails on this machine with `symlinkSync EPERM` (Windows without Developer Mode — pre-existing, unrelated; CI is authoritative). Any other failure is yours.

- [ ] **Step 3: Commit the changeset and plan**

```bash
git add .changeset/knowledge-wire-protocol.md docs/superpowers/plans/2026-07-24-eng-359-knowledge-wire-protocol.md
git commit -m "chore(core): changeset + implementation plan for the knowledge wire protocol (ENG-359)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Verify branch state**

Run: `git log --oneline main..HEAD` — expected: exactly the three commits above. `git status` clean apart from the untracked `.superpowers/` scratch dir.
