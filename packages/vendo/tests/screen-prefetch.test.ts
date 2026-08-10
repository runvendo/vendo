import type { Json, ToolListing, ToolResult } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { toolBrief } from "../src/screen-agent.js";
import { PREFETCH_TOOL_CHARS, prefetchReads, prefetchableReads } from "../src/screen-prefetch.js";

const listing = (name: string, extra: Partial<ToolListing> = {}): ToolListing => ({
  name,
  title: name,
  description: name,
  risk: "read",
  inputSchema: { type: "object", properties: {} },
  ...extra,
});

const RESERVED = ["validate", "search_components"];

describe("the reads a screen resolves before the model starts", () => {
  it("takes a declared no-argument read and leaves everything it would have to guess", () => {
    const eligible = prefetchableReads([
      listing("host_listAccounts"),
      // Optional properties only: the host's own schema says `{}` is a legal call.
      listing("host_listGoals", { inputSchema: { type: "object", properties: { limit: { type: "number" } } } }),
      // A required argument only the document can choose.
      listing("host_listTransfers", {
        inputSchema: { type: "object", properties: { limit: { type: "number" } }, required: ["limit"] },
      }),
      // Blind: nothing could read this tool's input, so it is NOT a no-argument tool.
      listing("host_search", { inputSchema: { type: "object", properties: {}, additionalProperties: true } }),
      listing("host_transfer", { risk: "write" }),
      listing("validate"),
      listing("vendo_apps_data_list"),
    ], RESERVED).map(({ name }) => name);

    expect(eligible).toEqual(["host_listAccounts", "host_listGoals"]);
  });

  it("resolves them once through the turn's tools, and a refusal is simply absent", async () => {
    const calls: string[] = [];
    const tools = {
      async call(name: string, args: Json): Promise<ToolResult> {
        calls.push(`${name}:${JSON.stringify(args)}`);
        if (name === "host_denied") return { status: "denied", reason: "not connected" };
        return { status: "ok", output: { data: [{ balance: 941220 }] } };
      },
    };

    const resolved = await prefetchReads(
      tools,
      [listing("host_listAccounts"), listing("host_denied")],
      RESERVED,
    );

    expect(calls).toEqual(["host_listAccounts:{}", "host_denied:{}"]);
    expect(resolved.get("host_listAccounts")).toBe('{"data":[{"balance":941220}]}');
    expect(resolved.has("host_denied")).toBe(false);
  });

  it("drops a result too large for the brief rather than printing half of it", async () => {
    const tools = {
      async call(): Promise<ToolResult> {
        return { status: "ok", output: { rows: "x".repeat(PREFETCH_TOOL_CHARS) } };
      },
    };

    const resolved = await prefetchReads(tools, [listing("host_listRows")], RESERVED);

    expect(resolved.size).toBe(0);
  });

  it("prints a resolved value on the tool's own card, beside its shape", () => {
    const brief = toolBrief(
      [listing("host_listAccounts"), listing("host_listGoals")],
      new Map([["host_listAccounts", '{"data":[]}']]),
    );

    expect(brief).toContain('read just now: {"data":[]}');
    // The tool nothing was fetched for says nothing — today's behaviour, exactly.
    expect(brief.match(/read just now/g)).toHaveLength(1);
  });
});
