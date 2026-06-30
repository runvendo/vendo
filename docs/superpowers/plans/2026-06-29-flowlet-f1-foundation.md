# Flowlet F1 — Foundation + Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `flowlet-core` + `flowlet-react` packages and an example app that define Flowlet's contracts (tools, UI nodes, stream protocol, agent, registry) and prove them end-to-end with a scripted stub agent and stub renderer — no LLM, no real sandbox.

**Architecture:** Reuse the Vercel `ai` SDK `UIMessage` stream **directly** as the protocol; Flowlet-specific pieces ride typed `data-*` parts (`data-run`, `data-ui`, `data-approval`, `data-approval-response`, `data-action`). Tools mirror the MCP tool definition. A scripted stub agent emits a realistic `ai` SDK stream (text → approval → UI) via `createUIMessageStream`; a custom in-memory `ChatTransport` drives `useChat` with no HTTP server; the in-memory "return channel" delivers the approval response back into the running stub via the `onClientPart` callback. The React layer resolves `component` UI nodes through a registry and shows a placeholder for `generated` nodes.

**Tech Stack:** TypeScript, pnpm workspaces, Turborepo, Vitest, Zod (Standard Schema), `ai` v5 (`ai` + `@ai-sdk/react`), React 18, `@testing-library/react` + jsdom.

**Design spec:** `docs/superpowers/specs/2026-06-29-flowlet-f1-foundation-design.md`

**Note on `ai` SDK API:** This plan targets `ai` v5. The custom-`UIMessage`, `createUIMessageStream`/`writer.write`, and `ChatTransport` APIs are verified against v5 docs. If `ai` resolves to v6+, confirm `createUIMessageStream`, `UIMessageChunk` chunk shapes (`start` / `text-start` / `text-delta` / `text-end` / `data-*` / `finish`), and the `ChatTransport.sendMessages` signature before implementing the streaming tasks (7–9). Everything else is Flowlet-owned and stable.

---

## File structure

```
flowlet/
├─ package.json                      # root, private, workspace scripts
├─ pnpm-workspace.yaml
├─ turbo.json
├─ tsconfig.base.json
├─ packages/
│  ├─ flowlet-core/
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  ├─ vitest.config.ts
│  │  └─ src/
│  │     ├─ schema.ts                # Standard Schema typing + JSON-Schema boundary guard
│  │     ├─ tool.ts                  # FlowletTool, ToolAnnotations, ToolContext, MCP mapping
│  │     ├─ ui.ts                    # UINode + guards
│  │     ├─ protocol.ts              # FlowletUIMessage, data-part keys, part builders/guards
│  │     ├─ agent.ts                 # FlowletAgent, RunInput, ClientPart
│  │     ├─ registry.ts              # RegisteredComponent, ComponentRegistry
│  │     ├─ stub-agent.ts            # createStubAgent (scripted stream + approval pause)
│  │     ├─ *.test.ts                # colocated Vitest tests
│  │     └─ index.ts                 # barrel
│  └─ flowlet-react/
│     ├─ package.json
│     ├─ tsconfig.json
│     ├─ vitest.config.ts
│     └─ src/
│        ├─ transport.ts             # createLocalTransport (in-memory ChatTransport)
│        ├─ provider.tsx             # FlowletProvider + context
│        ├─ use-flowlet-chat.ts      # useFlowletChat hook
│        ├─ stub-renderer.tsx        # renders component nodes; placeholder for generated
│        ├─ *.test.tsx               # colocated tests (jsdom)
│        └─ index.ts
└─ examples/
   └─ basic/
      ├─ package.json
      ├─ index.html
      ├─ vite.config.ts
      └─ src/{main.tsx, App.tsx, components.tsx}
```

---

## Task 0: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
  - "examples/*"
```

- [ ] **Step 2: Create root `package.json`**

```json
{
  "name": "flowlet",
  "private": true,
  "version": "0.0.0",
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint"
  },
  "devDependencies": {
    "turbo": "^2.1.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint": {}
  }
}
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "jsx": "react-jsx",
    "noUncheckedIndexedAccess": true
  }
}
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules
dist
.turbo
*.tsbuildinfo
```

- [ ] **Step 6: Install and commit**

Run: `pnpm install`
Expected: workspace resolves with no packages yet (warnings OK).

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json .gitignore pnpm-lock.yaml
git commit -m "chore: monorepo scaffold (pnpm + turbo + ts base)"
```

---

## Task 1: `flowlet-core` package + schema layer

**Files:**
- Create: `packages/flowlet-core/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/schema.ts`, `src/schema.test.ts`

- [ ] **Step 1: Create `packages/flowlet-core/package.json`**

```json
{
  "name": "@flowlet/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "ai": "^5.0.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `packages/flowlet-core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/flowlet-core/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node" } });
```

- [ ] **Step 4: Write the failing test `src/schema.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { isJsonSchemaConvertible, toJsonSchema } from "./schema";

describe("schema boundary", () => {
  it("accepts a Zod schema as JSON-Schema-convertible", () => {
    expect(isJsonSchemaConvertible(z.object({ city: z.string() }))).toBe(true);
  });

  it("converts a Zod schema to a JSON Schema object with properties", () => {
    const json = toJsonSchema(z.object({ city: z.string() })) as Record<string, unknown>;
    expect(json.type).toBe("object");
    expect((json.properties as Record<string, unknown>).city).toBeDefined();
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter @flowlet/core test`
Expected: FAIL — cannot find module `./schema`.

- [ ] **Step 6: Implement `src/schema.ts`**

```ts
import { z } from "zod";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Flowlet contracts type schema fields against the Standard Schema interface
 * (Zod/Valibot/ArkType all implement it). Zod is Flowlet's default impl.
 */
export type FlowletSchema<T> = StandardSchemaV1<T>;

/** True if the schema can be converted to JSON Schema at the LLM/tool boundary. */
export function isJsonSchemaConvertible(schema: unknown): boolean {
  return schema instanceof z.ZodType;
}

/** Convert a boundary schema to JSON Schema. Zod path for now; throws otherwise. */
export function toJsonSchema(schema: unknown): unknown {
  if (schema instanceof z.ZodType) return z.toJSONSchema(schema);
  throw new Error("Schema at the LLM/tool boundary must be JSON-Schema-convertible (use Zod).");
}
```

> Note: Zod 3.24+ exposes `z.toJSONSchema`. If the installed Zod lacks it, add `zod-to-json-schema` and call it here instead — the public function signature stays the same.

- [ ] **Step 7: Add the `@standard-schema/spec` dependency**

Run: `pnpm --filter @flowlet/core add @standard-schema/spec`
Expected: dependency added.

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @flowlet/core test`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add packages/flowlet-core pnpm-lock.yaml
git commit -m "feat(core): schema layer (Standard Schema + JSON-Schema boundary)"
```

---

## Task 2: Tool interface + MCP mapping

**Files:**
- Create: `packages/flowlet-core/src/tool.ts`, `src/tool.test.ts`

- [ ] **Step 1: Write the failing test `src/tool.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTool, fromMcpTool, toMcpTool } from "./tool";

const echo = defineTool({
  name: "echo",
  description: "echo the input back",
  inputSchema: z.object({ text: z.string() }),
  annotations: { readOnlyHint: true },
  execute: async ({ text }) => text,
});

describe("tool interface", () => {
  it("executes", async () => {
    expect(await echo.execute({ text: "hi" }, { principal: undefined })).toBe("hi");
  });

  it("maps to an MCP tool definition (JSON Schema input)", () => {
    const mcp = toMcpTool(echo);
    expect(mcp.name).toBe("echo");
    expect((mcp.inputSchema as Record<string, unknown>).type).toBe("object");
    expect(mcp.annotations?.readOnlyHint).toBe(true);
  });

  it("ingests an MCP tool def into a FlowletTool", async () => {
    const tool = fromMcpTool(
      { name: "ping", description: "ping", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      async () => "pong",
    );
    expect(tool.name).toBe("ping");
    expect(await tool.execute({}, { principal: undefined })).toBe("pong");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/core test`
Expected: FAIL — cannot find module `./tool`.

- [ ] **Step 3: Implement `src/tool.ts`**

```ts
import type { FlowletSchema } from "./schema";
import { toJsonSchema } from "./schema";

/** Reuse MCP's standard annotation vocabulary as the broad permission signal. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Per-call context. `principal` is opaque in F1; F2 defines its shape. */
export interface ToolContext {
  principal?: unknown;
}

export interface FlowletTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: FlowletSchema<I>;
  outputSchema?: FlowletSchema<O>;
  annotations?: ToolAnnotations;
  /** Open slot for any custom gating metadata; policy lives in F2. */
  permission?: unknown;
  execute(input: I, ctx: ToolContext): Promise<O>;
}

/** Identity helper that fixes inference for tool authors. */
export function defineTool<I, O>(tool: FlowletTool<I, O>): FlowletTool<I, O> {
  return tool;
}

/** Shape of an MCP tool definition (the subset Flowlet maps to/from). */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: unknown; // JSON Schema
  annotations?: ToolAnnotations;
}

/** Flowlet tool -> MCP tool definition (JSON Schema at the boundary). */
export function toMcpTool(tool: FlowletTool): McpToolDef {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonSchema(tool.inputSchema),
    annotations: tool.annotations,
  };
}

/** MCP tool definition + an executor -> Flowlet tool. */
export function fromMcpTool(
  def: McpToolDef,
  execute: (input: unknown, ctx: ToolContext) => Promise<unknown>,
): FlowletTool {
  return {
    name: def.name,
    description: def.description ?? "",
    // The MCP def already carries JSON Schema; pass it through as the boundary schema.
    inputSchema: def.inputSchema as FlowletSchema<unknown>,
    annotations: def.annotations,
    execute,
  };
}
```

> Note: an MCP def's `inputSchema` is already JSON Schema, so `fromMcpTool` stores it directly; `toJsonSchema` is only used when converting a Flowlet-authored (Zod) tool outward.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-core/src/tool.ts packages/flowlet-core/src/tool.test.ts
git commit -m "feat(core): MCP-shaped tool interface + MCP mapping"
```

---

## Task 3: UI composition model

**Files:**
- Create: `packages/flowlet-core/src/ui.ts`, `src/ui.test.ts`

- [ ] **Step 1: Write the failing test `src/ui.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { isComponentNode, isGeneratedNode, type UINode } from "./ui";

describe("UINode", () => {
  it("discriminates component vs generated", () => {
    const comp: UINode = { id: "n1", kind: "component", source: "prewired", name: "Card", props: {} };
    const gen: UINode = { id: "n2", kind: "generated", payload: { anything: true } };
    expect(isComponentNode(comp)).toBe(true);
    expect(isGeneratedNode(comp)).toBe(false);
    expect(isGeneratedNode(gen)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/core test`
Expected: FAIL — cannot find module `./ui`.

- [ ] **Step 3: Implement `src/ui.ts`**

```ts
export type UINodeSource = "prewired" | "host";

export interface ComponentNode {
  id: string;
  kind: "component";
  source: UINodeSource;
  name: string;
  props: unknown;
  children?: UINode[];
}

export interface GeneratedNode {
  id: string;
  kind: "generated";
  payload: unknown; // fully opaque in F1; format chosen by F3
}

export type UINode = ComponentNode | GeneratedNode;

export const isComponentNode = (n: UINode): n is ComponentNode => n.kind === "component";
export const isGeneratedNode = (n: UINode): n is GeneratedNode => n.kind === "generated";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-core/src/ui.ts packages/flowlet-core/src/ui.test.ts
git commit -m "feat(core): UINode composition model (component | generated)"
```

---

## Task 4: Stream protocol (reuse `ai` SDK UIMessage + data-* parts)

**Files:**
- Create: `packages/flowlet-core/src/protocol.ts`, `src/protocol.test.ts`

- [ ] **Step 1: Write the failing test `src/protocol.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { SCHEMA_VERSION, type ApprovalRequest } from "./protocol";

describe("protocol", () => {
  it("exposes a schema version", () => {
    expect(typeof SCHEMA_VERSION).toBe("number");
  });

  it("types an approval request with a correlation id", () => {
    const req: ApprovalRequest = { approvalId: "a1", toolCallId: "t1", prompt: "ok?", input: {} };
    expect(req.approvalId).toBe("a1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/core test`
Expected: FAIL — cannot find module `./protocol`.

- [ ] **Step 3: Implement `src/protocol.ts`**

```ts
import type { UIMessage } from "ai";
import type { UINode } from "./ui";

export const SCHEMA_VERSION = 1 as const;

/** Run identity, carried as a (transient) data-run part at stream start. */
export interface RunInfo {
  runId: string;
  threadId: string;
  schemaVersion: number;
}

/** Approval request, carried as a data-approval part. */
export interface ApprovalRequest {
  approvalId: string;
  toolCallId: string;
  prompt: string;
  input: unknown;
  expiresAt?: number;
}

/** Approval response, carried as a data-approval-response client part. */
export interface ApprovalResponse {
  approvalId: string;
  approved: boolean;
  editedInput?: unknown;
}

/** Sandbox action, carried as a data-action client part (semantic shape; transport is F3). */
export interface ActionRequest {
  requestId: string;
  originNodeId: string;
  action: string;
  payload?: unknown;
}

/** Flowlet's typed data-* parts layered on the ai SDK UIMessage. */
export interface FlowletDataParts {
  run: RunInfo;
  ui: UINode;
  approval: ApprovalRequest;
}

/** The public message type: an ai SDK UIMessage with Flowlet data parts. */
export type FlowletUIMessage = UIMessage<never, FlowletDataParts>;

/** Client -> server parts (the return channel). */
export type ClientPart =
  | { type: "data-approval-response"; data: ApprovalResponse }
  | { type: "data-action"; data: ActionRequest };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-core/src/protocol.ts packages/flowlet-core/src/protocol.test.ts
git commit -m "feat(core): stream protocol over ai SDK UIMessage + data-* parts"
```

---

## Task 5: Agent interface + component registry

**Files:**
- Create: `packages/flowlet-core/src/agent.ts`, `src/registry.ts`, `src/registry.test.ts`

- [ ] **Step 1: Write the failing test `src/registry.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createRegistry } from "./registry";

describe("component registry", () => {
  it("registers and resolves by name", () => {
    const reg = createRegistry([
      { name: "Card", description: "a card", propsSchema: z.object({}), source: "prewired" },
    ]);
    expect(reg.get("Card")?.source).toBe("prewired");
    expect(reg.get("Missing")).toBeUndefined();
    expect(reg.list().map((c) => c.name)).toEqual(["Card"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/core test`
Expected: FAIL — cannot find module `./registry`.

- [ ] **Step 3: Implement `src/registry.ts`**

```ts
import type { FlowletSchema } from "./schema";
import type { UINodeSource } from "./ui";

/** Descriptor only. Host-component *provisioning* is an F3a concern, not this. */
export interface RegisteredComponent {
  name: string;
  description: string;        // drives LLM selection
  propsSchema: FlowletSchema<unknown>;
  source: UINodeSource;
}

export interface ComponentRegistry {
  get(name: string): RegisteredComponent | undefined;
  list(): RegisteredComponent[];
}

export function createRegistry(components: RegisteredComponent[]): ComponentRegistry {
  const map = new Map(components.map((c) => [c.name, c]));
  return {
    get: (name) => map.get(name),
    list: () => [...map.values()],
  };
}
```

- [ ] **Step 4: Implement `src/agent.ts`**

```ts
import type { UIMessageChunk } from "ai";
import type { FlowletTool } from "./tool";
import type { ClientPart } from "./protocol";

export interface RunInput {
  messages: { role: string; parts: unknown[] }[]; // ai SDK UIMessage[] at the call site
  tools: FlowletTool[];
  system?: string;
  principal?: unknown;       // opaque in F1
  signal: AbortSignal;
  /** In-band return channel: approval responses + sandbox actions reach the run here. */
  onClientPart?: (part: ClientPart) => void;
}

export interface FlowletAgent {
  /** Emits an ai SDK UIMessage stream (incl. Flowlet data-* parts). */
  run(input: RunInput): ReadableStream<UIMessageChunk>;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @flowlet/core test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/flowlet-core/src/agent.ts packages/flowlet-core/src/registry.ts packages/flowlet-core/src/registry.test.ts
git commit -m "feat(core): FlowletAgent interface + component registry"
```

---

## Task 6: Stub agent (scripted stream with approval pause)

**Files:**
- Create: `packages/flowlet-core/src/stub-agent.ts`, `src/stub-agent.test.ts`

- [ ] **Step 1: Write the failing test `src/stub-agent.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { createStubAgent } from "./stub-agent";

async function collect(stream: ReadableStream<any>): Promise<any[]> {
  const out: any[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("stub agent", () => {
  it("emits text then an approval, and resumes with a ui node after approval", async () => {
    const agent = createStubAgent();
    let onClientPart!: (p: any) => void;
    const stream = agent.run({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      onClientPart: (p) => {}, // replaced below
    });

    // Capture the agent's client-part sink by re-running with a capturing handler.
    // (createStubAgent stores the latest onClientPart; see implementation.)
    const agent2 = createStubAgent();
    const parts: any[] = [];
    const collecting = (async () => {
      const s = agent2.run({
        messages: [],
        tools: [],
        signal: new AbortController().signal,
        onClientPart: (p) => {},
      });
      const reader = s.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        if (value.type === "data-approval") {
          agent2.respondToApproval(value.data.approvalId, { approved: true });
        }
      }
    })();
    await collecting;

    const types = parts.map((p) => p.type);
    expect(types).toContain("data-approval");
    expect(types).toContain("data-ui");
    // approval comes before the ui node
    expect(types.indexOf("data-approval")).toBeLessThan(types.indexOf("data-ui"));

    // matched approval id
    const approval = parts.find((p) => p.type === "data-approval");
    expect(typeof approval.data.approvalId).toBe("string");

    void stream; // unused first stream, only used to assert run() returns a stream
    expect(stream).toBeInstanceOf(ReadableStream);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/core test`
Expected: FAIL — cannot find module `./stub-agent`.

- [ ] **Step 3: Implement `src/stub-agent.ts`**

```ts
import { createUIMessageStream, type UIMessageChunk } from "ai";
import type { FlowletAgent, RunInput } from "./agent";
import type { ApprovalResponse } from "./protocol";
import { SCHEMA_VERSION } from "./protocol";
import type { UINode } from "./ui";

/**
 * Scripted development fixture (no LLM). Emits: start -> run info -> text ->
 * approval (pauses) -> [awaits approval-response via onClientPart] -> ui -> finish.
 * The in-memory approval resolver is F1's stand-in for the real networked return channel.
 */
export interface StubAgent extends FlowletAgent {
  respondToApproval(approvalId: string, response: Omit<ApprovalResponse, "approvalId">): void;
}

export function createStubAgent(): StubAgent {
  const pending = new Map<string, (r: ApprovalResponse) => void>();

  function respondToApproval(approvalId: string, response: Omit<ApprovalResponse, "approvalId">) {
    pending.get(approvalId)?.({ approvalId, ...response });
    pending.delete(approvalId);
  }

  function run(input: RunInput): ReadableStream<UIMessageChunk> {
    // Bridge the public onClientPart return channel into the pending-approval map.
    const originalOnClientPart = input.onClientPart;
    input.onClientPart = (part) => {
      originalOnClientPart?.(part);
      if (part.type === "data-approval-response") {
        pending.get(part.data.approvalId)?.(part.data);
        pending.delete(part.data.approvalId);
      }
    };

    return createUIMessageStream<any>({
      execute: async ({ writer }) => {
        writer.write({ type: "start" });
        writer.write({
          type: "data-run",
          transient: true,
          data: { runId: "run-1", threadId: "thread-1", schemaVersion: SCHEMA_VERSION },
        });

        const textId = "t1";
        writer.write({ type: "text-start", id: textId });
        writer.write({ type: "text-delta", id: textId, delta: "Here is a demo card." });
        writer.write({ type: "text-end", id: textId });

        const approvalId = "approval-1";
        const approved = await new Promise<ApprovalResponse>((resolve) => {
          pending.set(approvalId, resolve);
          writer.write({
            type: "data-approval",
            id: approvalId,
            data: { approvalId, toolCallId: "tool-1", prompt: "Render the demo card?", input: {} },
          });
        });

        if (approved.approved) {
          const node: UINode = {
            id: "ui-1",
            kind: "component",
            source: "prewired",
            name: "DemoCard",
            props: { title: "Hello from Flowlet" },
          };
          writer.write({ type: "data-ui", id: node.id, data: node });
        }

        writer.write({ type: "finish" });
      },
    });
  }

  return { run, respondToApproval };
}
```

> Note: `createUIMessageStream<any>` is used because the stub writes both native chunks (`start`/`text-*`/`finish`) and Flowlet `data-*` parts; the `any` keeps the writer permissive. Consumers still see the typed `FlowletUIMessage` shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/core test`
Expected: PASS. If a chunk type name differs in the installed `ai` version, align `start`/`text-start`/`text-delta`/`text-end`/`finish` to that version's `UIMessageChunk` union (see plan header note).

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-core/src/stub-agent.ts packages/flowlet-core/src/stub-agent.test.ts
git commit -m "feat(core): scripted stub agent with in-memory approval pause"
```

---

## Task 7: `flowlet-core` barrel + build green

**Files:**
- Create: `packages/flowlet-core/src/index.ts`

- [ ] **Step 1: Create `src/index.ts`**

```ts
export * from "./schema";
export * from "./tool";
export * from "./ui";
export * from "./protocol";
export * from "./agent";
export * from "./registry";
export * from "./stub-agent";
```

- [ ] **Step 2: Build and typecheck**

Run: `pnpm --filter @flowlet/core build`
Expected: emits `dist/` with `.d.ts`, no type errors.

- [ ] **Step 3: Run all core tests**

Run: `pnpm --filter @flowlet/core test`
Expected: PASS (schema, tool, ui, protocol, registry, stub-agent).

- [ ] **Step 4: Commit**

```bash
git add packages/flowlet-core/src/index.ts
git commit -m "feat(core): public barrel; build green"
```

---

## Task 8: `flowlet-react` package + in-memory transport

**Files:**
- Create: `packages/flowlet-react/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/transport.ts`, `src/transport.test.ts`

- [ ] **Step 1: Create `packages/flowlet-react/package.json`**

```json
{
  "name": "@flowlet/react",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "peerDependencies": { "react": "^18.0.0", "react-dom": "^18.0.0" },
  "dependencies": {
    "@flowlet/core": "workspace:*",
    "@ai-sdk/react": "^1.0.0",
    "ai": "^5.0.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "jsdom": "^25.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

> Note: confirm the `@ai-sdk/react` version that pairs with `ai` v5 at install time; pin to the matching major.

- [ ] **Step 2: Create `packages/flowlet-react/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/flowlet-react/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "jsdom", globals: true } });
```

- [ ] **Step 4: Write the failing test `src/transport.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { createStubAgent } from "@flowlet/core";
import { createLocalTransport } from "./transport";

describe("local transport", () => {
  it("drives the stub agent and exposes a client-part sink", async () => {
    const agent = createStubAgent();
    const { transport, sendClientPart } = createLocalTransport(agent);

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "c1",
      messageId: undefined,
      messages: [],
      abortSignal: new AbortController().signal,
    } as any);

    const reader = stream.getReader();
    const seen: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push((value as any).type);
      if ((value as any).type === "data-approval") {
        sendClientPart({ type: "data-approval-response", data: { approvalId: (value as any).data.approvalId, approved: true } });
      }
    }
    expect(seen).toContain("data-approval");
    expect(seen).toContain("data-ui");
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter @flowlet/react test`
Expected: FAIL — cannot find module `./transport`.

- [ ] **Step 6: Implement `src/transport.ts`**

```ts
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { ClientPart, FlowletUIMessage } from "@flowlet/core";
import type { StubAgent } from "@flowlet/core";

export interface LocalTransport {
  transport: ChatTransport<FlowletUIMessage>;
  /** Push a client part (approval response / action) into the active run. */
  sendClientPart: (part: ClientPart) => void;
}

/**
 * In-memory transport: drives a (stub) agent with no HTTP. F1's stand-in for the
 * real networked transport built in F2/F3.
 */
export function createLocalTransport(agent: StubAgent): LocalTransport {
  let activeOnClientPart: ((part: ClientPart) => void) | undefined;

  const transport: ChatTransport<FlowletUIMessage> = {
    async sendMessages(options): Promise<ReadableStream<UIMessageChunk>> {
      return agent.run({
        messages: options.messages as unknown as UIMessage[],
        tools: [],
        signal: options.abortSignal ?? new AbortController().signal,
        onClientPart: (part) => activeOnClientPart?.(part),
      });
    },
    async reconnectToStream() {
      return null;
    },
  };

  // The agent's run wires onClientPart -> its approval resolver; we forward to it.
  const sendClientPart = (part: ClientPart) => {
    if (part.type === "data-approval-response") {
      agent.respondToApproval(part.data.approvalId, {
        approved: part.data.approved,
        editedInput: part.data.editedInput,
      });
    }
    activeOnClientPart?.(part);
  };

  return { transport, sendClientPart };
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @flowlet/react test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/flowlet-react pnpm-lock.yaml
git commit -m "feat(react): in-memory ChatTransport driving the stub agent"
```

---

## Task 9: Provider + `useFlowletChat` hook

**Files:**
- Create: `packages/flowlet-react/src/provider.tsx`, `src/use-flowlet-chat.ts`

- [ ] **Step 1: Implement `src/provider.tsx`**

```tsx
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createRegistry, type ComponentRegistry, type RegisteredComponent, type StubAgent } from "@flowlet/core";
import { createLocalTransport, type LocalTransport } from "./transport";

interface FlowletContextValue {
  registry: ComponentRegistry;
  local: LocalTransport;
}

const FlowletContext = createContext<FlowletContextValue | null>(null);

export interface FlowletProviderProps {
  agent: StubAgent;
  components: RegisteredComponent[];
  children: ReactNode;
}

export function FlowletProvider({ agent, components, children }: FlowletProviderProps) {
  const value = useMemo<FlowletContextValue>(
    () => ({ registry: createRegistry(components), local: createLocalTransport(agent) }),
    [agent, components],
  );
  return <FlowletContext.Provider value={value}>{children}</FlowletContext.Provider>;
}

export function useFlowletContext(): FlowletContextValue {
  const ctx = useContext(FlowletContext);
  if (!ctx) throw new Error("useFlowletContext must be used within a FlowletProvider");
  return ctx;
}
```

- [ ] **Step 2: Implement `src/use-flowlet-chat.ts`**

```ts
import { useChat } from "@ai-sdk/react";
import type { FlowletUIMessage } from "@flowlet/core";
import { useFlowletContext } from "./provider";

export function useFlowletChat() {
  const { registry, local } = useFlowletContext();
  const chat = useChat<FlowletUIMessage>({ transport: local.transport });

  /** Answer an approval request (the in-memory return channel). */
  const respondToApproval = (approvalId: string, approved: boolean, editedInput?: unknown) =>
    local.sendClientPart({ type: "data-approval-response", data: { approvalId, approved, editedInput } });

  return { ...chat, registry, respondToApproval };
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @flowlet/react typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/flowlet-react/src/provider.tsx packages/flowlet-react/src/use-flowlet-chat.ts
git commit -m "feat(react): FlowletProvider + useFlowletChat hook"
```

---

## Task 10: Stub renderer + end-to-end React test

**Files:**
- Create: `packages/flowlet-react/src/stub-renderer.tsx`, `src/index.ts`, `src/stub-renderer.test.tsx`

- [ ] **Step 1: Implement `src/stub-renderer.tsx`**

```tsx
import type { ComponentType } from "react";
import { isComponentNode, type UINode } from "@flowlet/core";
import { useFlowletContext } from "./provider";

/**
 * NON-PRODUCTION, NO SECURITY BOUNDARY. Renders component nodes from the registry
 * directly in the host tree, and a placeholder for generated nodes. The real
 * sandboxed stage replaces this in F3. API kept close to the future stage seam.
 */
export interface StubRendererProps {
  node: UINode;
  /** Optional map of component name -> React component for the example/tests. */
  impls?: Record<string, ComponentType<any>>;
}

export function StubRenderer({ node, impls = {} }: StubRendererProps) {
  const { registry } = useFlowletContext();

  if (isComponentNode(node)) {
    const known = registry.get(node.name);
    const Impl = impls[node.name];
    if (!known) return <div data-testid="unknown-node">Unknown component: {node.name}</div>;
    if (!Impl) return <div data-testid="unimpl-node">{node.name} (no impl)</div>;
    return (
      <div data-testid="component-node">
        <Impl {...(node.props as object)} />
      </div>
    );
  }

  return <div data-testid="generated-placeholder">[generated UI — rendered in the F3 sandbox]</div>;
}
```

- [ ] **Step 2: Create the barrel `src/index.ts`**

```ts
export * from "./provider";
export * from "./use-flowlet-chat";
export * from "./transport";
export * from "./stub-renderer";
```

- [ ] **Step 3: Write the failing test `src/stub-renderer.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createStubAgent } from "@flowlet/core";
import { z } from "zod";
import { FlowletProvider } from "./provider";
import { useFlowletChat } from "./use-flowlet-chat";
import { StubRenderer } from "./stub-renderer";

function DemoCard({ title }: { title: string }) {
  return <div data-testid="demo-card">{title}</div>;
}

function Harness() {
  const chat = useFlowletChat();
  const approval = chat.messages
    .flatMap((m: any) => m.parts)
    .find((p: any) => p.type === "data-approval");
  const uiNode = chat.messages
    .flatMap((m: any) => m.parts)
    .find((p: any) => p.type === "data-ui");

  return (
    <div>
      <button onClick={() => chat.sendMessage({ text: "hi" })}>send</button>
      {approval && !approval.__answered && (
        <button
          data-testid="approve"
          onClick={() => chat.respondToApproval(approval.data.approvalId, true)}
        >
          approve
        </button>
      )}
      {uiNode && <StubRenderer node={uiNode.data} impls={{ DemoCard }} />}
    </div>
  );
}

describe("end-to-end stub loop", () => {
  it("streams text -> approval -> approve -> renders the component node", async () => {
    render(
      <FlowletProvider
        agent={createStubAgent()}
        components={[{ name: "DemoCard", description: "a demo card", propsSchema: z.object({ title: z.string() }), source: "prewired" }]}
      >
        <Harness />
      </FlowletProvider>,
    );

    fireEvent.click(screen.getByText("send"));
    await waitFor(() => screen.getByTestId("approve"));
    fireEvent.click(screen.getByTestId("approve"));
    await waitFor(() => screen.getByTestId("demo-card"));
    expect(screen.getByTestId("demo-card").textContent).toBe("Hello from Flowlet");
  });
});
```

- [ ] **Step 4: Run test to verify it fails, then passes**

Run: `pnpm --filter @flowlet/react test`
Expected first: FAIL (renderer missing / loop incomplete). After Steps 1–2 are in place: PASS.

> If `useChat` does not surface `data-*` parts on `messages[].parts` in the installed version, read them via the `onData` callback into local state instead (see `ai` "streaming data" docs). The approval/ui data still flows through the same parts; only the read site changes.

- [ ] **Step 5: Build + typecheck the package**

Run: `pnpm --filter @flowlet/react build`
Expected: emits `dist/`, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/flowlet-react/src/stub-renderer.tsx packages/flowlet-react/src/index.ts packages/flowlet-react/src/stub-renderer.test.tsx
git commit -m "feat(react): stub renderer + end-to-end stub loop test"
```

---

## Task 11: Example app (proves the loop runs)

**Files:**
- Create: `examples/basic/package.json`, `index.html`, `vite.config.ts`, `src/main.tsx`, `src/App.tsx`, `src/components.tsx`

- [ ] **Step 1: Create `examples/basic/package.json`**

```json
{
  "name": "@flowlet/example-basic",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@flowlet/core": "workspace:*",
    "@flowlet/react": "workspace:*",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `examples/basic/index.html`**

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Flowlet Example</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

- [ ] **Step 3: Create `examples/basic/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()] });
```

- [ ] **Step 4: Create `examples/basic/src/components.tsx`**

```tsx
export function DemoCard({ title }: { title: string }) {
  return <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12 }}>{title}</div>;
}
```

- [ ] **Step 5: Create `examples/basic/src/App.tsx`**

```tsx
import { z } from "zod";
import { createStubAgent } from "@flowlet/core";
import { FlowletProvider, useFlowletChat, StubRenderer } from "@flowlet/react";
import { DemoCard } from "./components";

const agent = createStubAgent();
const components = [
  { name: "DemoCard", description: "a demo card", propsSchema: z.object({ title: z.string() }), source: "prewired" as const },
];

function Chat() {
  const chat = useFlowletChat();
  const parts = chat.messages.flatMap((m: any) => m.parts);
  const approval = parts.find((p: any) => p.type === "data-approval");
  const uiNode = parts.find((p: any) => p.type === "data-ui");
  const text = parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");

  return (
    <div style={{ fontFamily: "system-ui", maxWidth: 480, margin: "40px auto" }}>
      <button onClick={() => chat.sendMessage({ text: "show me a card" })}>Send</button>
      {text && <p>{text}</p>}
      {approval && <button onClick={() => chat.respondToApproval(approval.data.approvalId, true)}>Approve: {approval.data.prompt}</button>}
      {uiNode && <StubRenderer node={uiNode.data} impls={{ DemoCard }} />}
    </div>
  );
}

export function App() {
  return (
    <FlowletProvider agent={agent} components={components}>
      <Chat />
    </FlowletProvider>
  );
}
```

- [ ] **Step 6: Create `examples/basic/src/main.tsx`**

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 7: Install, build the workspace, verify the example builds**

Run: `pnpm install && pnpm build && pnpm --filter @flowlet/example-basic build`
Expected: all packages build; the example produces a `dist/` bundle.

- [ ] **Step 8: Manual smoke (optional but recommended)**

Run: `pnpm --filter @flowlet/example-basic dev`
Expected: open the URL, click Send → text appears → Approve button → click → DemoCard renders.

- [ ] **Step 9: Commit**

```bash
git add examples pnpm-lock.yaml
git commit -m "feat(example): basic app proving the stub loop end-to-end"
```

---

## Task 12: Whole-workspace green + README

**Files:**
- Create: `packages/flowlet-core/README.md`, `packages/flowlet-react/README.md`
- Modify: root `README.md`

- [ ] **Step 1: Run the full pipeline**

Run: `pnpm typecheck && pnpm build && pnpm test`
Expected: all three green across both packages.

- [ ] **Step 2: Write `packages/flowlet-core/README.md`**

```md
# @flowlet/core

Flowlet's framework-agnostic contracts: the MCP-shaped tool interface, the `UINode`
composition model, the stream protocol (reuses the `ai` SDK `UIMessage` + typed
`data-*` parts), the `FlowletAgent` interface, the component registry, and a scripted
stub agent. No React. See `docs/superpowers/specs/2026-06-29-flowlet-f1-foundation-design.md`.
```

- [ ] **Step 3: Write `packages/flowlet-react/README.md`**

```md
# @flowlet/react

`FlowletProvider`, `useFlowletChat`, an in-memory `ChatTransport`, and a NON-PRODUCTION
stub renderer (component nodes via the registry; placeholder for generated nodes — the
real sandboxed stage is F3). Pairs with `@flowlet/core`.
```

- [ ] **Step 4: Replace root `README.md`**

```md
# Flowlet

Monorepo for Flowlet. F1 (this milestone) ships the foundation contracts + stubs:

- `packages/flowlet-core` — tools, UI nodes, stream protocol, agent, registry, stub agent
- `packages/flowlet-react` — provider, `useFlowletChat`, in-memory transport, stub renderer
- `examples/basic` — proves the stub loop end-to-end

Design: `docs/superpowers/specs/2026-06-29-flowlet-f1-foundation-design.md`.
Reuse: `ai` SDK (protocol), MCP (tools + permission annotations), mcp-ui (sandbox — F3), Crayon (components — F4).

`pnpm install && pnpm build && pnpm test`
```

- [ ] **Step 5: Commit**

```bash
git add README.md packages/flowlet-core/README.md packages/flowlet-react/README.md
git commit -m "docs: package READMEs; F1 foundation complete"
```

---

## Definition of done

- `pnpm typecheck && pnpm build && pnpm test` all green.
- `@flowlet/core` exports the tool / UINode / protocol / agent / registry / stub-agent contracts; tests cover schema boundary, MCP tool mapping, UINode guards, protocol types, registry, and the scripted stub stream (text → approval → ui, correlated).
- `@flowlet/react` exports the provider, `useFlowletChat`, the in-memory transport, and the stub renderer; the end-to-end test drives send → approval → approve → component render.
- `examples/basic` builds and runs the loop in a browser.
- Every seam F2 (agent interface, tool/MCP, protocol, return channel) and F3 (UINode, registry, stub renderer at the stage seam) need is present and exercised by a test or the example.
