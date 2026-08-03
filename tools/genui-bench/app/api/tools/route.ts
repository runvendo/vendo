/**
 * The pane's tool transport target: POST {host, tool, input} executes the
 * named host fixture's canned-data tool and answers a contract ToolOutcome
 * (01-core §4) — ok output, or the error outcome a real tool pipe would
 * return (a VendoError's own code, e.g. "not-found" for an unknown tool).
 * Failures ride the outcome vocabulary, not HTTP errors, so the production
 * renderer's outcome handling is exercised as-is; only a malformed request
 * (unknown host, missing tool) is a 400.
 */
import { VendoError, type ToolOutcome } from "@vendoai/core";
import { fixtures } from "../../../fixtures";
import type { HostName } from "../../../runner/types";

export async function POST(request: Request): Promise<Response> {
  let body: { host?: unknown; tool?: unknown; input?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "body must be JSON: {host, tool, input}" }, { status: 400 });
  }

  const fixture = typeof body.host === "string" ? fixtures[body.host as HostName] : undefined;
  if (fixture === undefined) {
    return Response.json({ error: `unknown host "${String(body.host)}" (maple|cadence)` }, { status: 400 });
  }
  if (typeof body.tool !== "string" || body.tool === "") {
    return Response.json({ error: "tool must be a non-empty string" }, { status: 400 });
  }
  const input =
    typeof body.input === "object" && body.input !== null && !Array.isArray(body.input)
      ? (body.input as Record<string, unknown>)
      : {};

  try {
    const output = await fixture.execute(body.tool, input);
    return Response.json({ status: "ok", output } as ToolOutcome);
  } catch (error) {
    const outcome: ToolOutcome = {
      status: "error",
      error: {
        code: error instanceof VendoError ? error.code : "execution",
        message: error instanceof Error ? error.message : String(error),
      },
    };
    return Response.json(outcome);
  }
}
