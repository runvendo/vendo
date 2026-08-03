/**
 * Self-hosted CopilotKit v2 runtime endpoint (keyless/local — no CopilotKit
 * account). The bench adapter calls the same handler in-process; this route
 * exists so browser-side CopilotKit clients can reach the runtime too.
 */
import { buildCopilotRuntimeHandler, type RuntimeHandler } from "../../../lanes/copilotkit";

let handler: RuntimeHandler | undefined;

function dispatch(request: Request): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Promise.resolve(
      Response.json({ error: "no key — set ANTHROPIC_API_KEY in the root .env" }, { status: 503 }),
    );
  }
  handler ??= buildCopilotRuntimeHandler();
  return handler(request);
}

export function POST(request: Request): Promise<Response> {
  return dispatch(request);
}

export function GET(request: Request): Promise<Response> {
  return dispatch(request);
}
