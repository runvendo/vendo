import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import { buildToolset } from "./toolset";
import type { ApprovalPolicy } from "./policy";
import type { FlowletPrincipal } from "./principal";
import type { ToolDescriptor } from "./descriptor";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const principal: FlowletPrincipal = { userId: "u1" };
const allowPolicy: ApprovalPolicy = { evaluate: () => "allow" };

/** Minimal Tool with an execute — the smallest valid input for wrapTool. */
function makeTool(label: string) {
  return tool({
    description: label,
    inputSchema: z.object({}),
    execute: async () => label,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildToolset", () => {
  it("empty sources -> empty toolset", () => {
    const result = buildToolset({ sources: [], policy: allowPolicy, principal });
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("precedence: caller beats composio; onCollision is called with correct args", () => {
    const callerTool = makeTool("caller");
    const composioTool = makeTool("composio");
    const onCollision = vi.fn();

    const result = buildToolset({
      sources: [
        { source: "caller", tools: { toolA: callerTool } },
        { source: "composio", tools: { toolA: composioTool } },
      ],
      policy: allowPolicy,
      principal,
      onCollision,
    });

    // toolA must be present
    expect(result.toolA).toBeDefined();
    // collision reported once: kept=caller (first), dropped=composio (second)
    expect(onCollision).toHaveBeenCalledOnce();
    expect(onCollision).toHaveBeenCalledWith("toolA", "caller", "composio");
  });

  it("all tools are wrapped: returned tool is not the same reference and needsApproval is a function", () => {
    const raw = makeTool("engine-tool");

    const result = buildToolset({
      sources: [{ source: "engine", tools: { myTool: raw } }],
      policy: allowPolicy,
      principal,
    });

    const wrapped = result.myTool;
    expect(wrapped).toBeDefined();
    // wrapTool shallow-clones, so the reference must differ
    expect(wrapped).not.toBe(raw);
    // the wrapper installs a function for needsApproval
    expect(typeof wrapped!.needsApproval).toBe("function");
  });

  it("composio descriptors are reused: tool is registered and is not the raw reference", () => {
    const composioTool = makeTool("composio-tool");
    const prebuiltDescriptor: ToolDescriptor = {
      name: "cTool",
      source: "composio",
      annotations: { readOnlyHint: true },
      hasExecute: true,
      kind: "function",
    };

    const result = buildToolset({
      sources: [
        {
          source: "composio",
          tools: { cTool: composioTool },
          descriptors: { cTool: prebuiltDescriptor },
        },
      ],
      policy: allowPolicy,
      principal,
    });

    // Tool is present and was wrapped (not the raw reference)
    expect(result.cTool).toBeDefined();
    expect(result.cTool).not.toBe(composioTool);
  });

  it("no-execute tool is skipped; onSkip called; sibling tools in the same source are still registered", () => {
    const goodTool = makeTool("good");
    // A tool object with NO execute property — wrapTool will throw for this
    const noExecTool = { inputSchema: z.object({}) } as ReturnType<typeof tool>;
    const onSkip = vi.fn();

    const result = buildToolset({
      sources: [
        {
          source: "engine",
          tools: {
            good: goodTool,
            bad: noExecTool,
          },
        },
      ],
      policy: allowPolicy,
      principal,
      onSkip,
    });

    // bad is absent (fail-closed)
    expect(result.bad).toBeUndefined();
    // good is still registered
    expect(result.good).toBeDefined();
    // onSkip was called for bad with source and a reason string
    expect(onSkip).toHaveBeenCalledOnce();
    expect(onSkip).toHaveBeenCalledWith("bad", "engine", expect.any(String));
  });

  it("threads writer through to wrapTool: needsApproval writes a data-consent part", async () => {
    const writes: unknown[] = [];
    const writer = { write: (part: unknown) => writes.push(part) } as never;
    const raw = tool({
      description: "mutating",
      inputSchema: z.object({}),
      execute: async () => "ok",
    });
    const descriptor: ToolDescriptor = {
      name: "mutate", source: "caller",
      annotations: { destructiveHint: false }, hasExecute: true, kind: "function",
    };

    const result = buildToolset({
      sources: [
        { source: "caller", tools: { mutate: raw }, descriptors: { mutate: descriptor } },
      ],
      policy: allowPolicy,
      principal,
      writer,
    });

    const wrapped = result.mutate!;
    await (wrapped.needsApproval as (input: unknown, options: unknown) => Promise<boolean>)(
      {},
      { toolCallId: "call-1", messages: [] },
    );
    expect(writes).toHaveLength(1);
  });
});
