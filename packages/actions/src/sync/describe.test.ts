import { describe, expect, it } from "vitest";
import type { ExtractedTool } from "../formats.js";
import { withGeneratedDescriptions, generatedToolDescription } from "./describe.js";

const routeTool = (over: Partial<ExtractedTool>): ExtractedTool => ({
  name: "host_get_invoices",
  description: "",
  inputSchema: {},
  risk: "read",
  binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
  ...over,
});

describe("generatedToolDescription", () => {
  it("writes a use-this-when line from a GET route", () => {
    expect(generatedToolDescription(routeTool({}))).toBe(
      "Use this to read or list invoices (GET /api/invoices).",
    );
  });

  it("writes an action line from a POST route with a trailing verb segment", () => {
    const tool = routeTool({
      name: "host_post_invoices_id_remind",
      risk: "write",
      binding: { kind: "route", method: "POST", path: "/api/invoices/:id/remind", argsIn: "body" },
    });
    expect(generatedToolDescription(tool)).toBe(
      "Use this to remind for one invoices record (POST /api/invoices/:id/remind).",
    );
  });

  it("writes update/delete lines from method", () => {
    expect(generatedToolDescription(routeTool({
      risk: "write",
      binding: { kind: "route", method: "PATCH", path: "/api/budgets/:id", argsIn: "body" },
    }))).toBe("Use this to update one budgets record (PATCH /api/budgets/:id).");
    expect(generatedToolDescription(routeTool({
      risk: "destructive",
      binding: { kind: "route", method: "DELETE", path: "/api/budgets/:id", argsIn: "body" },
    }))).toBe("Use this to delete one budgets record (DELETE /api/budgets/:id).");
  });

  it("falls back to name tokens for non-route bindings", () => {
    const tool = routeTool({
      name: "host_transactions_search",
      binding: { kind: "trpc", procedure: "transactions.search", type: "query" },
    } as Partial<ExtractedTool>);
    expect(generatedToolDescription(tool)).toBe("Use this to read transactions search.");
  });
});

describe("withGeneratedDescriptions", () => {
  it("fills only EMPTY descriptions; host-provided text is untouched", () => {
    const tools = withGeneratedDescriptions([
      routeTool({}),
      routeTool({ name: "host_other", description: "The host wrote this." }),
    ]);
    expect(tools[0]!.description).toContain("Use this to");
    expect(tools[1]!.description).toBe("The host wrote this.");
  });
});
