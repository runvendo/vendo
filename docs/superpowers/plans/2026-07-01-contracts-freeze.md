# Contracts Freeze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the two contract surfaces the parallel platform tracks build against — the `.flowlet/` manifest schema (theme.json, components, tools.json + host events) and the five runtime seam interfaces (Store, CredentialBroker, Executor, Scheduler, Channels) — as additive TypeScript + JSON Schema + docs in `@flowlet/core`, gated on Yousef's mid-flight review of an open-questions doc.

**Architecture:** Everything lands additively in `packages/flowlet-core` (the contracts package per the platform architecture spec, Decision 7): a new `src/manifest/` module (zod schemas, mirroring the existing `BrandTokens` and descriptor shapes so current artifacts already conform) and a new `src/seams/` module (documented interfaces only, embedded-vs-cloud mapping captured in TSDoc). JSON Schema artifacts are generated from the zod schemas into `packages/flowlet-core/schemas/` and kept in sync by a test. Reconciliation with the existing hand-written artifacts is proven by tests in `flowlet-components` (which already depends on core — no cycle). NO changes to `flowlet-agent` (ENG-202 owns it), no refactors, no runtime carve-out.

**Tech Stack:** TypeScript, zod 3 (already a core dep), `zod-to-json-schema` + `ajv` (new devDeps in core), vitest.

**Process gate (binding):** After Task 10 (open-questions doc), set the worktree comment to "questions ready" and PAUSE. Do NOT finalize contracts or open the PR until answers come back through the orchestrator. Tasks 11+ run only after the review.

---

### Task 0: Branch rename + baseline check

The orchestrator mandated branch `yousef/contracts-freeze`; the worktree is on `yousefh409/contracts-freeze`.

**Files:** none

- [ ] **Step 1: Rename the branch in place**

```bash
git branch -m yousefh409/contracts-freeze yousef/contracts-freeze
```

- [ ] **Step 2: Confirm the workspace builds/tests clean before touching anything**

Run: `pnpm typecheck && pnpm test`
Expected: both pass (turbo-cached). If they fail on main's code, STOP and report — don't fix unrelated breakage.

---

### Task 1: Manifest theme schema (`theme.json`)

Structurally identical to `brandTokensSchema` in `packages/flowlet-components/src/theme/brand.ts` so every existing theme artifact conforms. Duplication (not import) is deliberate: components→core dependency already exists, so core cannot import components; a reconciliation test (Task 6) prevents drift. Folding `brand.ts` onto this schema is a later, non-additive session.

**Files:**
- Create: `packages/flowlet-core/src/manifest/theme.ts`
- Test: `packages/flowlet-core/src/manifest/theme.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/flowlet-core/src/manifest/theme.test.ts
import { describe, expect, it } from "vitest";
import { manifestThemeSchema } from "./theme";

const valid = {
  version: 1,
  accent: "#0A7CFF",
  background: "#FFFFFF",
  surface: "#F5F7FA",
  text: "#111418",
  mutedText: "#5B6470",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  radius: 8,
  mode: "light",
};

describe("manifestThemeSchema", () => {
  it("accepts a fully resolved v1 theme", () => {
    expect(manifestThemeSchema.parse(valid)).toEqual(valid);
  });

  it("accepts px-string radius and omitted mode", () => {
    const { mode: _mode, ...rest } = valid;
    expect(() => manifestThemeSchema.parse({ ...rest, radius: "8.5px" })).not.toThrow();
  });

  it("rejects non-hex colors (no var()/url() references)", () => {
    expect(() => manifestThemeSchema.parse({ ...valid, accent: "var(--accent)" })).toThrow();
  });

  it("rejects unknown versions", () => {
    expect(() => manifestThemeSchema.parse({ ...valid, version: 2 })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/core test -- theme.test`
Expected: FAIL — cannot resolve `./theme`

- [ ] **Step 3: Write the schema**

```ts
// packages/flowlet-core/src/manifest/theme.ts
import { z } from "zod";

/** A literal hex color (#rgb / #rgba / #rrggbb / #rrggbbaa). No var()/url() references. */
const hexColor = z
  .string()
  .regex(/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);

/**
 * `theme.json` — extracted host design tokens (dev-tool artifact 1 of 3,
 * architecture Decision 3). Fully resolved primitives only: the sandbox has no
 * host CSS vars or loaded fonts.
 *
 * Structurally identical to `BrandTokens` v1 in `@flowlet/components`
 * (`src/theme/brand.ts`), which is the consuming side of this contract; a
 * reconciliation test there keeps the two in sync until they are folded together.
 */
export const manifestThemeSchema = z.object({
  version: z.literal(1),
  accent: hexColor,
  background: hexColor,
  surface: hexColor,
  text: hexColor,
  mutedText: hexColor,
  fontFamily: z.string().min(1),
  radius: z.union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d+)?px$/)]),
  mode: z.enum(["light", "dark"]).optional(),
});

export type ManifestTheme = z.infer<typeof manifestThemeSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/core test -- theme.test`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-core/src/manifest/theme.ts packages/flowlet-core/src/manifest/theme.test.ts
git commit -m "feat(core): manifest theme schema (theme.json contract)"
```

---

### Task 2: Tool descriptors + annotations + bindings (`tools.json` tools)

The spec (Decision 3) requires "mutating/dangerous annotations". Draft position (open question Q3): Flowlet-native **required** booleans `{ mutating, dangerous }` — policy needs definite values, so no optional "hints" — with the MCP mapping (`readOnlyHint = !mutating`, `destructiveHint = dangerous`) documented for ingestion into `flowlet-agent`'s `ToolDescriptor`. Named `ManifestTool*` to avoid colliding with names ENG-202 may export.

**Files:**
- Create: `packages/flowlet-core/src/manifest/tool.ts`
- Test: `packages/flowlet-core/src/manifest/tool.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/flowlet-core/src/manifest/tool.test.ts
import { describe, expect, it } from "vitest";
import { manifestToolSchema } from "./tool";

const listInvoices = {
  name: "listInvoices",
  description: "List the user's invoices, newest first.",
  inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  annotations: { mutating: false, dangerous: false },
  binding: { type: "http", method: "GET", path: "/api/invoices" },
};

describe("manifestToolSchema", () => {
  it("accepts a read-only http tool", () => {
    expect(() => manifestToolSchema.parse(listInvoices)).not.toThrow();
  });

  it("accepts a mutating+dangerous tool with a templated path", () => {
    expect(() =>
      manifestToolSchema.parse({
        ...listInvoices,
        name: "cancelInvoice",
        annotations: { mutating: true, dangerous: true, idempotent: true },
        binding: { type: "http", method: "POST", path: "/api/invoices/{id}/cancel" },
      }),
    ).not.toThrow();
  });

  it("requires annotations — no unsound defaults", () => {
    const { annotations: _a, ...rest } = listInvoices;
    expect(() => manifestToolSchema.parse(rest)).toThrow();
  });

  it("rejects unknown binding types and bad names", () => {
    expect(() =>
      manifestToolSchema.parse({ ...listInvoices, binding: { type: "grpc" } }),
    ).toThrow();
    expect(() => manifestToolSchema.parse({ ...listInvoices, name: "1bad name" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/core test -- tool.test`
Expected: FAIL — cannot resolve `./tool` (note: `src/tool.test.ts` doesn't exist today, only `src/tool.ts`; the new test is `src/manifest/tool.test.ts`, disambiguated by path)

- [ ] **Step 3: Write the schema**

```ts
// packages/flowlet-core/src/manifest/tool.ts
import { z } from "zod";

/**
 * A JSON Schema document, kept opaque. Tool inputs and event payloads are
 * declared as JSON Schema in the manifest (the wire format); zod is the
 * in-process representation and the ai SDK converts at the model boundary.
 */
export const jsonSchemaDocument = z.record(z.unknown());
export type JsonSchemaDocument = Record<string, unknown>;

/**
 * Safety annotations, REQUIRED on every manifest tool (architecture Decision 3).
 * Policy reads definite values — a tool with unknown safety cannot be published.
 *
 * MCP mapping (for ingestion into runtime tool descriptors):
 * `readOnlyHint = !mutating`, `destructiveHint = dangerous`,
 * `idempotentHint = idempotent`.
 */
export const manifestToolAnnotationsSchema = z.object({
  /** Writes host state. `false` = safe to call freely (read-only). */
  mutating: z.boolean(),
  /** Danger-gated: policy emits an approval card (interactive) or requires
   *  pre-authorized scopes / async approval (automations). */
  dangerous: z.boolean(),
  /** Optional: repeat calls with the same input are safe. */
  idempotent: z.boolean().optional(),
});
export type ManifestToolAnnotations = z.infer<typeof manifestToolAnnotationsSchema>;

/**
 * How a tool call physically reaches the host API. `http` is the only binding
 * frozen now; the discriminated union is the extension point (trpc, graphql —
 * ENG-197 extractor targets). Path segments in `{braces}` are template
 * parameters filled from the tool input by name.
 */
export const httpBindingSchema = z.object({
  type: z.literal("http"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  /** Host-relative path template, e.g. `/api/invoices/{id}/cancel`. */
  path: z.string().min(1),
});
export const manifestToolBindingSchema = z.discriminatedUnion("type", [httpBindingSchema]);
export type ManifestToolBinding = z.infer<typeof manifestToolBindingSchema>;

/**
 * One entry in `tools.json` (dev-tool artifact 3 of 3, architecture Decision 3):
 * a host-API surface exposed to the agent as a tool. Developer-editable;
 * `flowlet publish` validates against this schema before upload.
 */
export const manifestToolSchema = z.object({
  /** Tool-call identifier presented to the model. */
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  /** Drives LLM tool selection — same role as component descriptions. */
  description: z.string().min(1),
  /** JSON Schema for the tool input. */
  inputSchema: jsonSchemaDocument,
  annotations: manifestToolAnnotationsSchema,
  binding: manifestToolBindingSchema,
});
export type ManifestTool = z.infer<typeof manifestToolSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/core test -- tool.test`
Expected: PASS (4 tests). The pre-existing `src/tool.test.ts` may also run — it must still pass untouched.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-core/src/manifest/tool.ts packages/flowlet-core/src/manifest/tool.test.ts
git commit -m "feat(core): manifest tool schema with mutating/dangerous annotations and http binding"
```

---

### Task 3: Host event declarations (automation triggers)

Decision 3: tools.json "also declares host event types available as automation triggers"; Decision 5: signed webhooks from the host backend carry these events.

**Files:**
- Create: `packages/flowlet-core/src/manifest/event.ts`
- Test: `packages/flowlet-core/src/manifest/event.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/flowlet-core/src/manifest/event.test.ts
import { describe, expect, it } from "vitest";
import { hostEventSchema } from "./event";

describe("hostEventSchema", () => {
  it("accepts a namespaced event with a payload schema", () => {
    expect(() =>
      hostEventSchema.parse({
        name: "invoice.paid",
        description: "An invoice was paid in full.",
        payloadSchema: { type: "object", properties: { invoiceId: { type: "string" } } },
      }),
    ).not.toThrow();
  });

  it("accepts an event without a payload schema", () => {
    expect(() =>
      hostEventSchema.parse({ name: "user.deactivated", description: "Account deactivated." }),
    ).not.toThrow();
  });

  it("rejects un-namespaced or malformed names", () => {
    expect(() => hostEventSchema.parse({ name: "paid", description: "x" })).toThrow();
    expect(() => hostEventSchema.parse({ name: "Invoice.Paid!", description: "x" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/core test -- event.test`
Expected: FAIL — cannot resolve `./event`

- [ ] **Step 3: Write the schema**

```ts
// packages/flowlet-core/src/manifest/event.ts
import { z } from "zod";
import { jsonSchemaDocument } from "./tool";

/**
 * A host event type declared in `tools.json`, available as an automation
 * trigger (architecture Decisions 3 & 5). At runtime the host backend delivers
 * instances as signed webhooks to the cloud worker; embedded hosts may invoke
 * the ingest path in-process. Names are dot-namespaced, lower_snake segments:
 * `invoice.paid`, `user.plan_changed`.
 */
export const hostEventSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  /** Drives trigger selection when the compiler agent builds an automation. */
  description: z.string().min(1),
  /** JSON Schema for the event payload; omitted = opaque payload. */
  payloadSchema: jsonSchemaDocument.optional(),
});
export type HostEventDeclaration = z.infer<typeof hostEventSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/core test -- event.test`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-core/src/manifest/event.ts packages/flowlet-core/src/manifest/event.test.ts
git commit -m "feat(core): host event declarations for automation triggers"
```

---

### Task 4: Component entries + file-level and published manifest shapes

`components/` in `.flowlet/` is code (descriptor + wrapper pairs); what the *published manifest* carries is the serialized descriptor: `{name, description, propsSchema-as-JSON-Schema}` — the JSON image of the existing `PrewiredDescriptor`/`RegisteredComponent`. Also freezes: `toolsManifestSchema` (the tools.json *file*: version + tools + events), `flowletManifestSchema` (the published unit), and `ManifestRef` (what a session binds to).

**Files:**
- Create: `packages/flowlet-core/src/manifest/component.ts`
- Create: `packages/flowlet-core/src/manifest/manifest.ts`
- Create: `packages/flowlet-core/src/manifest/index.ts`
- Test: `packages/flowlet-core/src/manifest/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/flowlet-core/src/manifest/manifest.test.ts
import { describe, expect, it } from "vitest";
import { manifestComponentSchema } from "./component";
import { flowletManifestSchema, toolsManifestSchema } from "./manifest";

const theme = {
  version: 1,
  accent: "#0A7CFF",
  background: "#FFFFFF",
  surface: "#F5F7FA",
  text: "#111418",
  mutedText: "#5B6470",
  fontFamily: "system-ui, sans-serif",
  radius: 8,
};
const tool = {
  name: "listInvoices",
  description: "List invoices.",
  inputSchema: { type: "object" },
  annotations: { mutating: false, dangerous: false },
  binding: { type: "http", method: "GET", path: "/api/invoices" },
};
const component = {
  name: "InvoiceCard",
  description: "The host's invoice summary card.",
  propsSchema: { type: "object", properties: { invoiceId: { type: "string" } } },
};

describe("manifestComponentSchema", () => {
  it("accepts a serialized descriptor", () => {
    expect(() => manifestComponentSchema.parse(component)).not.toThrow();
  });
});

describe("toolsManifestSchema (tools.json file)", () => {
  it("accepts tools + events, defaulting events to []", () => {
    const parsed = toolsManifestSchema.parse({ version: 1, tools: [tool] });
    expect(parsed.events).toEqual([]);
  });
});

describe("flowletManifestSchema (published unit)", () => {
  it("accepts a complete manifest", () => {
    expect(() =>
      flowletManifestSchema.parse({
        schemaVersion: 1,
        theme,
        tools: [tool],
        events: [],
        components: [component],
      }),
    ).not.toThrow();
  });

  it("rejects a manifest missing the theme", () => {
    expect(() =>
      flowletManifestSchema.parse({ schemaVersion: 1, tools: [], events: [], components: [] }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/core test -- manifest.test`
Expected: FAIL — cannot resolve `./component` / `./manifest`

- [ ] **Step 3: Write the schemas**

```ts
// packages/flowlet-core/src/manifest/component.ts
import { z } from "zod";
import { jsonSchemaDocument } from "./tool";

/**
 * The published image of one entry in `.flowlet/components/` (dev-tool artifact
 * 2 of 3). On disk each entry is a descriptor + wrapper pair compiled into the
 * sandbox bundle; the published manifest carries only the descriptor, with the
 * props schema serialized to JSON Schema. This is the JSON form of
 * `RegisteredComponent` / `PrewiredDescriptor` (name, description, propsSchema).
 */
export const manifestComponentSchema = z.object({
  name: z.string().min(1),
  /** Drives LLM component selection — same field as `RegisteredComponent.description`. */
  description: z.string().min(1),
  /** JSON Schema for the component props (zod-serialized at publish time). */
  propsSchema: jsonSchemaDocument,
});
export type ManifestComponent = z.infer<typeof manifestComponentSchema>;
```

```ts
// packages/flowlet-core/src/manifest/manifest.ts
import { z } from "zod";
import { manifestThemeSchema } from "./theme";
import { manifestToolSchema } from "./tool";
import { hostEventSchema } from "./event";
import { manifestComponentSchema } from "./component";

/**
 * The `tools.json` FILE as it sits in `.flowlet/` in the host repo:
 * host-API tool descriptors plus declared host event types (Decision 3).
 * Developer-editable after extraction.
 */
export const toolsManifestSchema = z.object({
  version: z.literal(1),
  tools: z.array(manifestToolSchema),
  events: z.array(hostEventSchema).default([]),
});
export type ToolsManifest = z.infer<typeof toolsManifestSchema>;

/**
 * The published manifest — the immutable unit `flowlet publish` uploads to the
 * cloud registry and a session binds to at init (Decision 3). Assembled from
 * the three `.flowlet/` artifacts; the sandbox component bundle travels
 * alongside, referenced by the registry row, not embedded here.
 *
 * Embedded mode reads the same shape directly from `.flowlet/` on disk;
 * publish is a no-op there.
 */
export const flowletManifestSchema = z.object({
  schemaVersion: z.literal(1),
  theme: manifestThemeSchema,
  tools: z.array(manifestToolSchema),
  events: z.array(hostEventSchema),
  components: z.array(manifestComponentSchema),
});
export type FlowletManifest = z.infer<typeof flowletManifestSchema>;

/**
 * Registry identity of a published manifest. Rows are immutable — a re-publish
 * is a new row with an active pointer per environment (Decision 3/6). Sessions
 * carry a ManifestRef, never a mutable manifest.
 */
export interface ManifestRef {
  tenantId: string;
  /** Publisher-supplied version label (e.g. git sha or semver). */
  version: string;
  /** Content hash of the published manifest, assigned by the registry. */
  hash: string;
}
```

```ts
// packages/flowlet-core/src/manifest/index.ts
export * from "./theme";
export * from "./tool";
export * from "./event";
export * from "./component";
export * from "./manifest";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/core test -- manifest.test`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-core/src/manifest/component.ts packages/flowlet-core/src/manifest/manifest.ts packages/flowlet-core/src/manifest/index.ts packages/flowlet-core/src/manifest/manifest.test.ts
git commit -m "feat(core): component entries, tools.json file shape, published manifest + ManifestRef"
```

---

### Task 5: JSON Schema artifacts, generated and sync-tested

Committed JSON Schema files are the language-neutral contract the dev tool (ENG-197) and registry (ENG-198) validate against. Generated from zod (single source of truth); a test regenerates and diffs, so drift fails CI. `ajv` proves the emitted schemas actually validate.

**Files:**
- Create: `packages/flowlet-core/scripts/generate-schemas.ts`
- Create: `packages/flowlet-core/schemas/theme.schema.json` (generated)
- Create: `packages/flowlet-core/schemas/tools.schema.json` (generated)
- Create: `packages/flowlet-core/schemas/manifest.schema.json` (generated)
- Test: `packages/flowlet-core/src/manifest/schemas.test.ts`
- Modify: `packages/flowlet-core/package.json` (add devDeps `zod-to-json-schema`, `ajv`, `tsx`; add `generate:schemas` script)

- [ ] **Step 1: Add devDependencies and script**

In `packages/flowlet-core/package.json`, add to `"scripts"`:

```json
"generate:schemas": "tsx scripts/generate-schemas.ts"
```

and to `"devDependencies"`:

```json
"ajv": "^8.17.0",
"tsx": "^4.19.0",
"zod-to-json-schema": "^3.24.0"
```

Run: `pnpm install`
Expected: lockfile updated, no peer warnings from these three.

- [ ] **Step 2: Write the failing sync test**

```ts
// packages/flowlet-core/src/manifest/schemas.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { generatedSchemas } from "../../scripts/generate-schemas";

const schemasDir = join(__dirname, "..", "..", "schemas");

describe("committed JSON Schema artifacts", () => {
  for (const [file, schema] of Object.entries(generatedSchemas)) {
    it(`${file} is in sync with the zod source (run pnpm generate:schemas)`, () => {
      const committed = JSON.parse(readFileSync(join(schemasDir, file), "utf8"));
      expect(committed).toEqual(schema);
    });

    it(`${file} compiles under ajv and validates a known artifact`, () => {
      const ajv = new Ajv({ strict: false });
      expect(() => ajv.compile(schema)).not.toThrow();
    });
  }

  it("theme.schema.json accepts the flowlet-components default brand shape", () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(
      JSON.parse(readFileSync(join(schemasDir, "theme.schema.json"), "utf8")),
    );
    expect(
      validate({
        version: 1,
        accent: "#0A7CFF",
        background: "#FFFFFF",
        surface: "#F5F7FA",
        text: "#111418",
        mutedText: "#5B6470",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        radius: 8,
        mode: "light",
      }),
    ).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @flowlet/core test -- schemas.test`
Expected: FAIL — cannot resolve `../../scripts/generate-schemas`

- [ ] **Step 4: Write the generator**

```ts
// packages/flowlet-core/scripts/generate-schemas.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { manifestThemeSchema } from "../src/manifest/theme";
import { toolsManifestSchema, flowletManifestSchema } from "../src/manifest/manifest";

const opts = { target: "jsonSchema7" as const, $refStrategy: "none" as const };

/** file name -> JSON Schema document. Imported by the sync test; run as a script to write. */
export const generatedSchemas: Record<string, Record<string, unknown>> = {
  "theme.schema.json": zodToJsonSchema(manifestThemeSchema, opts) as Record<string, unknown>,
  "tools.schema.json": zodToJsonSchema(toolsManifestSchema, opts) as Record<string, unknown>,
  "manifest.schema.json": zodToJsonSchema(flowletManifestSchema, opts) as Record<string, unknown>,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
  mkdirSync(outDir, { recursive: true });
  for (const [file, schema] of Object.entries(generatedSchemas)) {
    writeFileSync(join(outDir, file), JSON.stringify(schema, null, 2) + "\n");
    console.log(`wrote schemas/${file}`);
  }
}
```

- [ ] **Step 5: Generate the artifacts, then run the test**

Run: `pnpm --filter @flowlet/core generate:schemas && pnpm --filter @flowlet/core test -- schemas.test`
Expected: three `wrote schemas/...` lines, then PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/flowlet-core/scripts/generate-schemas.ts packages/flowlet-core/schemas packages/flowlet-core/src/manifest/schemas.test.ts packages/flowlet-core/package.json pnpm-lock.yaml
git commit -m "feat(core): committed JSON Schema artifacts generated from zod, sync-tested"
```

---

### Task 6: Reconciliation tests in flowlet-components (additive test file only)

Proves "current code is already near-conformant": the real `defaultBrand` parses under the core manifest theme schema, and every prewired descriptor serializes into a valid `ManifestComponent`. Lives in flowlet-components because components→core is the existing dependency direction. Touches no production files.

**Files:**
- Test: `packages/flowlet-components/src/manifest-conformance.test.ts`
- Modify: `packages/flowlet-components/package.json` (devDep `zod-to-json-schema`)

- [ ] **Step 1: Add devDependency**

In `packages/flowlet-components/package.json` devDependencies add `"zod-to-json-schema": "^3.24.0"`, then run `pnpm install`.

- [ ] **Step 2: Write the test (fails only if contracts diverge — that's the point)**

```ts
// packages/flowlet-components/src/manifest-conformance.test.ts
import { describe, expect, it } from "vitest";
import { manifestThemeSchema, manifestComponentSchema } from "@flowlet/core";
import { zodToJsonSchema } from "zod-to-json-schema";
import { defaultBrand, brandTokensSchema } from "./theme/brand";
import { descriptors } from "./descriptors";

describe("existing artifacts conform to the frozen manifest contracts", () => {
  it("defaultBrand is a valid manifest theme", () => {
    expect(() => manifestThemeSchema.parse(defaultBrand)).not.toThrow();
  });

  it("brandTokensSchema and manifestThemeSchema agree on shape", () => {
    // Same generated JSON Schema = structurally identical contracts.
    expect(zodToJsonSchema(brandTokensSchema, { $refStrategy: "none" })).toEqual(
      zodToJsonSchema(manifestThemeSchema, { $refStrategy: "none" }),
    );
  });

  it("every prewired descriptor serializes to a valid ManifestComponent", () => {
    for (const d of descriptors) {
      const entry = {
        name: d.name,
        description: d.description,
        propsSchema: zodToJsonSchema(d.propsSchema, { $refStrategy: "none" }) as Record<
          string,
          unknown
        >,
      };
      expect(() => manifestComponentSchema.parse(entry), d.name).not.toThrow();
    }
  });
});
```

- [ ] **Step 3: Build core so components resolves the new exports, then run**

Note: this test needs Task 8's core index export to be in place if `@flowlet/core` resolves via `dist`. If it fails on missing exports, do Task 8 Step 1 first, rebuild core, and return here.

Run: `pnpm --filter @flowlet/core build && pnpm --filter @flowlet/components test -- manifest-conformance`
Expected: PASS (3 tests)

- [ ] **Step 4: Commit**

```bash
git add packages/flowlet-components/src/manifest-conformance.test.ts packages/flowlet-components/package.json pnpm-lock.yaml
git commit -m "test(components): existing brand + descriptors conform to frozen manifest contracts"
```

---

### Task 7: The five seam interfaces

Interfaces + TSDoc only; the embedded/cloud mapping from architecture Decision 1's table goes verbatim into each seam's doc comment. A single stub-implementation test proves the shapes are implementable in-memory (the embedded/CI guarantee in miniature). No runtime code, no carve-out.

**Files:**
- Create: `packages/flowlet-core/src/seams/principal.ts`
- Create: `packages/flowlet-core/src/seams/store.ts`
- Create: `packages/flowlet-core/src/seams/credential-broker.ts`
- Create: `packages/flowlet-core/src/seams/executor.ts`
- Create: `packages/flowlet-core/src/seams/scheduler.ts`
- Create: `packages/flowlet-core/src/seams/channels.ts`
- Create: `packages/flowlet-core/src/seams/index.ts`
- Test: `packages/flowlet-core/src/seams/seams.test.ts`

- [ ] **Step 1: Write the failing stub test**

```ts
// packages/flowlet-core/src/seams/seams.test.ts
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "./credential-broker";
import type { Executor } from "./executor";
import type { Principal } from "./principal";
import type { Scheduler } from "./scheduler";
import type { Channels } from "./channels";
import type { Store, ThreadStore, SavedFlowletStore, AutomationStore, AuditLog } from "./store";

const principal: Principal = { tenantId: "t1", subject: "u1" };

// Minimal in-memory implementations: the embedded/CI guarantee in miniature.
// If these can't be written without a database or HTTP server, the seam is wrong.
function makeStore(): Store {
  const threads: ThreadStore = {
    create: async (scope, init) => ({
      id: "th1",
      tenantId: scope.tenantId,
      subject: scope.subject,
      title: init?.title,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-01T00:00:00Z",
    }),
    get: async () => undefined,
    list: async () => [],
    appendMessages: async () => {},
    getMessages: async () => [],
  };
  const flowlets: SavedFlowletStore = {
    save: async (scope, f) => ({ ...f, id: "f1" }),
    get: async () => undefined,
    list: async () => [],
    delete: async () => {},
  };
  const automations: AutomationStore = {
    save: async (scope, a) => ({ ...a, id: "a1" }),
    get: async () => undefined,
    list: async () => [],
    recordRun: async () => {},
    listRuns: async () => [],
  };
  const audit: AuditLog = { append: async () => {} };
  return { threads, flowlets, automations, audit };
}

describe("seam interfaces are implementable in-memory", () => {
  it("Store", async () => {
    const store = makeStore();
    const t = await store.threads.create(principal, { title: "hi" });
    expect(t.tenantId).toBe("t1");
  });

  it("CredentialBroker", async () => {
    const broker: CredentialBroker = {
      authenticate: async () => principal,
      acquireGrant: async (req) => ({
        token: "grant",
        expiresAt: "2026-07-01T00:05:00Z",
        scopes: req.scopes,
      }),
    };
    expect((await broker.authenticate("host-session")).subject).toBe("u1");
    expect(
      (await broker.acquireGrant({ principal, automationId: "a1", scopes: ["invoices:read"] }))
        .scopes,
    ).toEqual(["invoices:read"]);
  });

  it("Executor", async () => {
    const executor: Executor = {
      execute: async (call) => ({ result: { echoed: call.input } }),
    };
    const out = await executor.execute(
      { toolCallId: "c1", toolName: "listInvoices", input: { limit: 1 } },
      { principal },
    );
    expect("result" in out).toBe(true);
  });

  it("Scheduler", async () => {
    const fired: string[] = [];
    let handler: ((f: { automationId: string; firedAt: string }) => Promise<void>) | undefined;
    const scheduler: Scheduler = {
      schedule: async (id) => {
        await handler?.({ automationId: id, firedAt: "2026-07-01T00:00:00Z" });
      },
      cancel: async () => {},
      onFire: (h) => {
        handler = h;
      },
    };
    scheduler.onFire(async (f) => {
      fired.push(f.automationId);
    });
    await scheduler.schedule("a1", { kind: "cron", expression: "0 9 * * *" });
    expect(fired).toEqual(["a1"]);
  });

  it("Channels", async () => {
    const sent: string[] = [];
    const channels: Channels = {
      deliver: async (msg) => {
        sent.push(msg.channel);
      },
    };
    await channels.deliver({ channel: "in-app", principal, text: "done" });
    expect(sent).toEqual(["in-app"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/core test -- seams.test`
Expected: FAIL — cannot resolve `./principal` etc.

- [ ] **Step 3: Write the interfaces**

```ts
// packages/flowlet-core/src/seams/principal.ts
/**
 * The verified identity every seam operation is scoped to.
 * - Embedded: derived in-process from the host session (tenant is implicit;
 *   embedded hosts may use a fixed tenantId).
 * - Cloud: derived from the vouch JWT at session init (Decision 4); users are
 *   unique per (tenant, subject), no PII beyond the vouch claims.
 */
export interface Principal {
  tenantId: string;
  /** The host's stable user identifier (the vouch `sub`). */
  subject: string;
  /** Vouch claims passed through verbatim (roles, plan, etc.). */
  claims?: Record<string, unknown>;
}
```

```ts
// packages/flowlet-core/src/seams/store.ts
import type { FlowletUIMessage } from "../protocol";
import type { UINode } from "../ui";
import type { Principal } from "./principal";

/**
 * Store seam — threads, saved flowlets, automations, audit (Decision 1/6).
 *
 * | Deployment | Implementation |
 * |---|---|
 * | Embedded | host's choice; in-memory or SQLite in CI (demo-bank) |
 * | Cloud | Postgres in apps/cloud, all access behind this seam |
 *
 * All operations are scoped by Principal (tenant + subject); embedded
 * implementations may ignore tenantId. Timestamps are ISO 8601 strings.
 *
 * Memory (ENG-189) is deliberately NOT here yet: the architecture reserves a
 * Store concern and a context-assembly injection point, defined when that work
 * starts. Adding a `memory` member later is an additive change to this seam.
 */
export interface Store {
  threads: ThreadStore;
  flowlets: SavedFlowletStore;
  automations: AutomationStore;
  audit: AuditLog;
}

export interface ThreadRecord {
  id: string;
  tenantId: string;
  subject: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

/** Persisted UIMessage streams (replaces the demo's in-memory route state). */
export interface ThreadStore {
  create(scope: Principal, init?: { title?: string }): Promise<ThreadRecord>;
  get(scope: Principal, threadId: string): Promise<ThreadRecord | undefined>;
  list(scope: Principal): Promise<ThreadRecord[]>;
  appendMessages(scope: Principal, threadId: string, messages: FlowletUIMessage[]): Promise<void>;
  getMessages(scope: Principal, threadId: string): Promise<FlowletUIMessage[]>;
}

/**
 * A saved flowlet (ENG-183, Decision 6): declarative UI tree + bound data
 * query + originating prompt. Reopening re-renders the tree and re-runs the
 * query through the normal tool path (policy applies).
 */
export interface SavedFlowlet {
  id: string;
  name: string;
  pinned: boolean;
  uiTree: UINode;
  /** Re-executed via the Executor on reopen — never a raw DB query. */
  query: { toolName: string; input: unknown };
  originatingPrompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavedFlowletStore {
  save(scope: Principal, flowlet: Omit<SavedFlowlet, "id">): Promise<SavedFlowlet>;
  get(scope: Principal, id: string): Promise<SavedFlowlet | undefined>;
  list(scope: Principal): Promise<SavedFlowlet[]>;
  delete(scope: Principal, id: string): Promise<void>;
}

/**
 * Automation records. The spec DSL is deliberately opaque here (`spec:
 * unknown`) — its shape is decided at ENG-188's brainstorm (Decision 5). This
 * store freezes only what every design needs: identity, lifecycle, run history.
 */
export interface AutomationRecord {
  id: string;
  name: string;
  status: "enabled" | "paused";
  /** The compiled automation spec — interpreted JSON step graph or agent goal.
   *  Opaque until ENG-188 freezes the DSL. */
  spec: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "succeeded" | "failed";
  error?: string;
}

export interface AutomationStore {
  save(scope: Principal, automation: Omit<AutomationRecord, "id">): Promise<AutomationRecord>;
  get(scope: Principal, id: string): Promise<AutomationRecord | undefined>;
  list(scope: Principal): Promise<AutomationRecord[]>;
  recordRun(scope: Principal, run: AutomationRun): Promise<void>;
  listRuns(scope: Principal, automationId: string): Promise<AutomationRun[]>;
}

/**
 * Append-only audit record of every tool execution, approval, grant exchange,
 * and automation firing (Decision 6). Written from day 1; ENG-194 is UI over it.
 */
export type AuditEvent = { at: string; principal: Principal } & (
  | {
      kind: "tool_execution";
      toolName: string;
      toolCallId: string;
      mutating: boolean;
      dangerous: boolean;
      outcome: "ok" | "error";
    }
  | { kind: "approval"; toolCallId: string; decision: "approved" | "denied" }
  | { kind: "grant_exchange"; automationId: string; scopes: string[] }
  | { kind: "automation_firing"; automationId: string; runId: string }
);

export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
}
```

```ts
// packages/flowlet-core/src/seams/credential-broker.ts
import type { Principal } from "./principal";

/**
 * CredentialBroker seam — how a tool call gets user identity (Decisions 1/4).
 *
 * | Deployment | Implementation |
 * |---|---|
 * | Embedded | host session, in-process; `authenticate` is a pass-through, `acquireGrant` returns the ambient identity |
 * | Cloud | vouch JWT verification at session init + RFC 8693-shaped token exchange for automations |
 *
 * Interactive host-API calls need NO credential from this seam at all — the
 * browser executes them on the user's existing session (Decision 2). The
 * broker covers the other two credential lifetimes: session identity and the
 * short-lived brokered grant automations run under.
 */
export interface CredentialBroker {
  /**
   * Turn the SDK-presented credential into a verified Principal at session
   * init. Cloud: the vouch JWT string. Embedded: whatever the host passes
   * in-process (opaque here).
   */
  authenticate(credential: unknown): Promise<Principal>;

  /**
   * Exchange a signed assertion for a short-lived scoped user token, held only
   * for one automation run. Revocation lives on the host side. Only required
   * once a tenant enables automations.
   */
  acquireGrant(request: GrantRequest): Promise<BrokeredGrant>;
}

export interface GrantRequest {
  principal: Principal;
  automationId: string;
  /** Scopes pre-authorized at automation creation (Decision 4). */
  scopes: string[];
}

export interface BrokeredGrant {
  /** Bearer token for host-API calls during this run. Never persisted. */
  token: string;
  /** ISO 8601 expiry; the run must not outlive it without re-exchange. */
  expiresAt: string;
  scopes: string[];
}
```

```ts
// packages/flowlet-core/src/seams/executor.ts
import type { BrokeredGrant } from "./credential-broker";
import type { Principal } from "./principal";

/**
 * Executor seam — where a tool call physically runs (Decisions 1/2).
 *
 * | Deployment | Implementation |
 * |---|---|
 * | Embedded | in-process against the host backend |
 * | Cloud, interactive | client executor: the call streams to the SDK, the browser fetches the host API on the user's session, the result returns via the ai SDK client-tool round trip |
 * | Cloud, automation | server executor in the worker, authorized by a BrokeredGrant |
 *
 * The runtime selects an executor per tool call; the policy layer has already
 * evaluated the call before it reaches any executor. Non-streaming by design:
 * a tool call resolves to one outcome (mirrors `ActionResult`).
 */
export interface Executor {
  execute(call: ToolCallRequest, context: ExecutionContext): Promise<ToolCallOutcome>;
}

export interface ToolCallRequest {
  /** ai SDK tool-call id — links outcome, approval, and audit entries. */
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ExecutionContext {
  principal: Principal;
  /** Present only on server-executed automation runs. */
  grant?: BrokeredGrant;
  signal?: AbortSignal;
}

export type ToolCallOutcome =
  | { result: unknown }
  | { error: { code: string; message: string } };
```

```ts
// packages/flowlet-core/src/seams/scheduler.ts
/**
 * Scheduler seam — firing automations when the user is away (Decisions 1/5).
 *
 * | Deployment | Implementation |
 * |---|---|
 * | Embedded | none, or host cron invoking the handler |
 * | Cloud | pg-boss worker in apps/cloud |
 *
 * This seam owns TIME-based triggers only. The other two trigger sources
 * (signed host webhooks, Composio triggers) are ingest paths that invoke the
 * same firing handler directly — they don't pass through the Scheduler.
 */
export interface Scheduler {
  /** Register (or replace) the durable schedule for an automation. */
  schedule(automationId: string, trigger: TimeTrigger): Promise<void>;
  cancel(automationId: string): Promise<void>;
  /** The runtime registers exactly one firing handler at startup. */
  onFire(handler: (firing: AutomationFiring) => Promise<void>): void;
}

export type TimeTrigger =
  | { kind: "cron"; expression: string; timezone?: string }
  | { kind: "at"; at: string };

export interface AutomationFiring {
  automationId: string;
  firedAt: string;
}
```

```ts
// packages/flowlet-core/src/seams/channels.ts
import type { Principal } from "./principal";

/**
 * Channels seam — reaching the user off-thread (Decision 1).
 *
 * | Deployment | Implementation |
 * |---|---|
 * | Embedded | in-app only |
 * | Cloud | in-app now; SMS (ENG-191) and voice (ENG-185) later |
 *
 * Message-shaped delivery only. Realtime voice is a session, not a message —
 * it gets its own contract at ENG-185 time and is deliberately NOT squeezed
 * into `deliver`.
 */
export interface Channels {
  deliver(message: OutboundMessage): Promise<void>;
}

export type ChannelKind = "in-app" | "sms";

export interface OutboundMessage {
  channel: ChannelKind;
  principal: Principal;
  /** Plain-text body; in-app surfaces may upgrade rendering later. */
  text: string;
  /** Thread to attach in-app deliveries to; ignored by SMS. */
  threadId?: string;
}
```

```ts
// packages/flowlet-core/src/seams/index.ts
export * from "./principal";
export * from "./store";
export * from "./credential-broker";
export * from "./executor";
export * from "./scheduler";
export * from "./channels";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/core test -- seams.test`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-core/src/seams
git commit -m "feat(core): five runtime seam interfaces with embedded/cloud mapping"
```

---

### Task 8: Export from the core barrel (additive lines only)

**Files:**
- Modify: `packages/flowlet-core/src/index.ts` (append two lines)

- [ ] **Step 1: Append exports**

```ts
export * from "./manifest";
export * from "./seams";
```

- [ ] **Step 2: Full-workspace verification**

Run: `pnpm build && pnpm typecheck && pnpm test && pnpm lint`
Expected: all pass. Watch specifically for name collisions from the new `export *` (e.g. anything in flowlet-agent doing `export * from "@flowlet/core"`). If a collision appears, rename the core-side type (never touch flowlet-agent).

- [ ] **Step 3: Commit**

```bash
git add packages/flowlet-core/src/index.ts
git commit -m "feat(core): export manifest and seam contracts"
```

---

### Task 9: Short docs

Two focused docs under `docs/contracts/` + a pointer from the core README. Succinct, no filler.

**Files:**
- Create: `docs/contracts/manifest.md` — the three artifacts, one example each, the annotations table (with MCP mapping), host events, publish/bind lifecycle, pointer to `packages/flowlet-core/schemas/`.
- Create: `docs/contracts/seams.md` — the five interfaces, the embedded/cloud table from the architecture spec, one paragraph per seam on what is frozen vs deferred (memory, automation DSL, voice).
- Modify: `packages/flowlet-core/README.md` — append a "Contracts" section linking both docs.

- [ ] **Step 1: Write both docs** (content follows the TSDoc already written; keep each under ~120 lines)
- [ ] **Step 2: Append the README pointer**
- [ ] **Step 3: Commit**

```bash
git add docs/contracts packages/flowlet-core/README.md
git commit -m "docs: manifest schema and runtime seam contracts"
```

---

### Task 10: Open-questions doc — THE GATE

**Files:**
- Create: `docs/superpowers/specs/2026-07-01-contracts-freeze-open-questions.md`

- [ ] **Step 1: Write the doc.** Every point where the contract could reasonably go two ways, each with both options, the draft's current position, and a recommendation. Minimum set (add any discovered during implementation):

1. **Annotation vocabulary** — Flowlet-native required `{mutating, dangerous}` vs MCP hints (`readOnlyHint`/`destructiveHint`, optional). Draft/rec: Flowlet-native required, documented MCP mapping.
2. **Tool binding shape** — freeze a minimal `http` binding now vs leave `binding` opaque for ENG-202/197. Draft/rec: minimal `http` in a discriminated union.
3. **Theme schema ownership** — core duplicates `brandTokensSchema` (sync-tested) now; later fold components onto core's schema? Rec: yes, separate session.
4. **Published manifest vs component bundle** — descriptors in the manifest, compiled sandbox bundle referenced by the registry row (not embedded). Confirm.
5. **Store granularity** — one `Store` aggregating sub-stores vs five separate seam params. Draft/rec: aggregate.
6. **Automation spec opacity** — `spec: unknown` until ENG-188 vs a minimal envelope now. Draft/rec: opaque.
7. **Memory reservation** — no `memory` member until ENG-189 (additive later) vs placeholder now. Draft/rec: none.
8. **Executor result shape** — Promise of one outcome vs streaming. Draft/rec: non-streaming.
9. **Scheduler scope** — time triggers only (webhooks/Composio are ingest paths) . Confirm.
10. **Channels + voice** — message-shaped `deliver` for in-app/SMS; voice reserved for its own contract at ENG-185. Confirm.
11. **Timestamps** — ISO 8601 strings everywhere vs `Date`. Draft/rec: strings.
12. **`authenticate(credential: unknown)`** — opaque credential vs typed vouch shape. Draft/rec: opaque (embedded passes host sessions).

- [ ] **Step 2: Commit, set the worktree comment, PAUSE**

```bash
git add docs/superpowers/specs/2026-07-01-contracts-freeze-open-questions.md
git commit -m "docs: contracts-freeze open questions for mid-flight review"
orca worktree set --worktree active --comment "questions ready"
```

**STOP HERE. Do not proceed to Task 11 until answers come back through the orchestrator.**

---

### Task 11 (post-review): Apply answers

- [ ] Apply each answer as targeted edits to the schemas/interfaces/tests/docs; re-run `pnpm generate:schemas` if manifest schemas changed; update the open-questions doc marking each question RESOLVED with the decision.
- [ ] Run: `pnpm build && pnpm typecheck && pnpm test && pnpm lint` — all pass.
- [ ] Commit: `git commit -m "feat(core): finalize contracts per mid-flight review"`

### Task 12 (post-review): PR

- [ ] Push: `git push -u origin yousef/contracts-freeze`
- [ ] Open a PR (never merge) titled "Contracts freeze: manifest schema + five runtime seams" — body: what's frozen, what's deliberately deferred (memory, automation DSL, voice), link to the open-questions doc with resolutions, note ADDITIVE-ONLY (no flowlet-agent changes).
- [ ] Set worktree comment: `orca worktree set --worktree active --comment "PR open: contracts freeze"`
