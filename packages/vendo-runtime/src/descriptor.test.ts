/**
 * WHY this side table exists:
 *
 * The Vercel ai SDK v6 `Tool` type has no `annotations` field, and the
 * MCP/Composio adapters surface annotation hints inconsistently (sometimes
 * under `_meta.annotations`, sometimes under a top-level `annotations` key,
 * sometimes not at all). Rather than pattern-matching on the SDK type at every
 * call site, the ingestion layer captures a `ToolDescriptor` once at
 * registration time. The guardrail policy engine reads annotations exclusively
 * from this descriptor — never from a field on the SDK tool object.
 */
import { describe, it, expect } from "vitest";
import { buildDescriptor } from "./descriptor.js";

describe("buildDescriptor", () => {
  it("extracts annotations from _meta.annotations when present", () => {
    const tool = {
      _meta: { annotations: { readOnlyHint: true } },
    };
    const descriptor = buildDescriptor("readThing", tool, "mcp");
    expect(descriptor.annotations.readOnlyHint).toBe(true);
    expect(descriptor.hasExecute).toBe(false);
    expect(descriptor.source).toBe("mcp");
    // no `type` property → defaults to "function"
    expect(descriptor.kind).toBe("function");
  });

  it("returns empty annotations and hasExecute true when tool has execute and type but no annotations", () => {
    const tool = {
      execute: async () => {},
      type: "function",
    };
    const descriptor = buildDescriptor("doWork", tool, "caller");
    expect(descriptor.annotations).toEqual({});
    expect(descriptor.hasExecute).toBe(true);
  });

  it("falls back to top-level annotations when _meta is absent", () => {
    const tool = {
      annotations: { destructiveHint: true },
    };
    const descriptor = buildDescriptor("deleteThing", tool, "engine");
    expect(descriptor.annotations.destructiveHint).toBe(true);
  });

  it("explicit annotations win over anything on the tool object", () => {
    const tool = {
      _meta: { annotations: { readOnlyHint: true } },
      annotations: { destructiveHint: true },
    };
    const explicit = { openWorldHint: true };
    const descriptor = buildDescriptor("mixedThing", tool, "composio", explicit);
    expect(descriptor.annotations).toEqual({ openWorldHint: true });
  });
});
