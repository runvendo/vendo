/**
 * POST /api/tools contract: executes the fixture tool and answers a
 * ToolOutcome; tool failures ride the outcome vocabulary (VendoError code
 * preserved), malformed requests are 400.
 */
import { describe, expect, it } from "vitest";
import type { ToolOutcome } from "@vendoai/core";
import { POST } from "./route";

const post = (body: unknown): Promise<Response> =>
  POST(new Request("http://localhost/api/tools", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

describe("POST /api/tools", () => {
  it("executes a fixture tool and answers {status:'ok', output}", async () => {
    const response = await post({ host: "maple", tool: "host_getProfile", input: {} });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as ToolOutcome;
    if (outcome.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
    expect((outcome.output as { name?: unknown }).name).toBeTypeOf("string");
  });

  it("answers the error outcome (VendoError code preserved) for an unknown tool", async () => {
    const response = await post({ host: "cadence", tool: "host_doesNotExist" });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as ToolOutcome;
    if (outcome.status !== "error") throw new Error(`expected error, got ${JSON.stringify(outcome)}`);
    expect(outcome.error.code).toBe("not-found");
  });

  it("rejects an unknown host with 400", async () => {
    const response = await post({ host: "nope", tool: "host_getProfile" });
    expect(response.status).toBe(400);
  });

  it("rejects a missing tool with 400", async () => {
    const response = await post({ host: "maple" });
    expect(response.status).toBe(400);
  });
});
