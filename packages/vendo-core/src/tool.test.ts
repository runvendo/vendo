import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "./tool";

describe("tool re-export", () => {
  it("re-exports the ai SDK `tool` factory and builds a tool definition", () => {
    const echo = tool({
      description: "echo the input back",
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => text,
    });
    expect(echo.description).toBe("echo the input back");
    expect(typeof echo.execute).toBe("function");
  });
});
