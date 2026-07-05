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
 *
 * NO persistence here — the SINGLE writer for thread messages is the engine's
 * `onSettled` hook, wired at agent construction in `agent.ts`'s
 * `createDemoAgent` (mirrors `packages/flowlet-next/src/handler.ts`). It fires
 * with the FULL settled message list — including the streamed assistant turn
 * and any approval-requested parts — keyed by the threadId resolved below, so
 * the consent endpoint can read this turn's approval part BEFORE the client's
 * next chat turn. Persisting the request body here too would double-append it
 * (and, alone, it would miss the streamed turn entirely — ENG-193 review
 * 2026-07-04, see `packages/flowlet-next`'s equivalent chat.ts/handler.ts fix).
 */
import { createUIMessageStreamResponse } from "ai";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FlowletAgent, FlowletUIMessage } from "@flowlet/core";
import { hostToolset } from "@flowlet/runtime";
import { enrichAnchorSources, createSourceResolver } from "@flowlet/next";
import { DEMO_PRINCIPAL } from "./principal";
import { cadenceHostToolDefs } from "./host-tools";
import { demoPrincipalAllowed, LOCAL_ONLY_MESSAGE } from "./local-guard";
import { CADENCE_SCOPE, resolveThreadRecordId } from "./store";

interface ChatRequestBody {
  /** The ai SDK Chat's own id (DefaultChatTransport's default body key — see
   *  the ENG-193 item-2 plan's "Plan deviations" #2). Falls back to a fixed
   *  thread when a caller (tests, an older client) omits it. */
  id?: string;
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
  const clientThreadId = typeof body.id === "string" && body.id.length > 0 ? body.id : "cadence-demo";
  const threadRecordId = await resolveThreadRecordId(CADENCE_SCOPE, clientThreadId);
  const stream = agent.run({
    // Strip any client-supplied source, then enrich the scoped anchor from the
    // raw file read (remix-fidelity epic).
    messages: enrichAnchorSources(messages, resolveRemixSource),
    // Cadence's own API surface enters through the caller seam (ENG-202): no
    // execute — the policy gates each call and the BROWSER executes approved
    // ones on the user's session via the SDK's host-tool runner.
    tools: hostToolset(cadenceHostToolDefs),
    principal: DEMO_PRINCIPAL,
    signal: req.signal,
    threadId: threadRecordId,
  });
  return createUIMessageStreamResponse({ stream });
}
