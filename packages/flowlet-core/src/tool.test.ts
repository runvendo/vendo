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
