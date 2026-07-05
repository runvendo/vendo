/**
 * The networked seam: turn an HTTP chat request into the agent's streamed
 * UIMessage response. Factored out of the route so it can be tested with a mock
 * agent (no model, no network). The principal is injected here — this is where
 * the server attaches the Composio identity that the client transport can't.
 *
 * Because the demo agent runs against real Gmail/Calendar connections, the
 * fixed DEMO_PRINCIPAL is only attached for local requests (the demo's primary
 * stage path). Set FLOWLET_DEMO_PUBLIC=1 to intentionally enable it on a
 * reachable deployment.
 */
import { createUIMessageStreamResponse } from "ai";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FlowletAgent, FlowletUIMessage } from "@flowlet/core";
import { hostToolset } from "@flowlet/runtime";
import {
  applyVerifiedPinBase,
  createSourceResolver,
  enrichAnchorSources,
  resolveRemixSealer,
} from "@flowlet/next";
import { DEMO_PRINCIPAL } from "./principal";
import { cadenceHostToolDefs } from "./host-tools";
import { demoPrincipalAllowed, LOCAL_ONLY_MESSAGE } from "./local-guard";

interface ChatRequestBody {
  messages?: FlowletUIMessage[];
}

/**
 * Remix-source map for the demo. `deadline-list.tsx` is a client component —
 * a RAW server-side file read (never an import, which would drag Next/browser
 * deps into the Node route). The @/-relative path resolves from the app root.
 */
const remixSourceMap: Record<string, string> = {
  "upcoming-deadlines": "src/components/dashboard/deadline-list.tsx",
};
const resolveRemixSource = createSourceResolver({
  option: (anchorId) => {
    const rel = remixSourceMap[anchorId];
    if (!rel) return undefined;
    try {
      return readFileSync(path.join(process.cwd(), rel), "utf8");
    } catch {
      return undefined; // file moved — fall open to the DOM-snapshot baseline
    }
  },
  captured: {},
});

export async function handleChat(req: Request, agent: FlowletAgent): Promise<Response> {
  if (!demoPrincipalAllowed(req)) {
    return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as ChatRequestBody;
  const messages = body.messages ?? [];
  // A missing/empty/non-array `messages` is a malformed client request. Reject
  // it cleanly — passed through, streamText throws AI_InvalidPromptError.
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "messages must be a non-empty array" }, { status: 400 });
  }
  const stream = agent.run({
    // Strip any client-supplied source, enrich the scoped anchor from the raw
    // file read (remix-fidelity epic), then verify the pin envelope into a
    // trusted base (remix fast-edits) — same key derivation as the agent's
    // sealer, so mint and verify agree.
    messages: applyVerifiedPinBase(
      enrichAnchorSources(messages, resolveRemixSource),
      resolveRemixSealer({ hasInjectedModel: false }),
      DEMO_PRINCIPAL.userId,
    ),
    // Cadence's own API surface enters through the caller seam (ENG-202): no
    // execute — the policy gates each call and the BROWSER executes approved
    // ones on the user's session via the SDK's host-tool runner.
    tools: hostToolset(cadenceHostToolDefs),
    principal: DEMO_PRINCIPAL,
    signal: req.signal,
  });
  return createUIMessageStreamResponse({ stream });
}
