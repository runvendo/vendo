// The chat route from Mastra's Next.js guide: handleChatStream streams the
// weather agent in AI SDK UI format for useChat.
import { handleChatStream } from '@mastra/ai-sdk';
import { RequestContext } from '@mastra/core/request-context';
import { createUIMessageStreamResponse } from 'ai';
import { mastra } from '@/mastra';
// --- vendo: the caller's principal rides Mastra's request context; a vendo_*
// call without one fails closed. Set server-side, never from the client.
import { VENDO_PRINCIPAL_KEY } from '@vendoai/vendo/mastra';
import { DEMO_PRINCIPAL, vendo } from '@/lib/vendo';
// --- /vendo

export async function POST(req: Request) {
  const params = await req.json();

  // --- vendo: guarded tools hit the store before any wire request does, and
  // every vendo_* call this turn runs as the (server-resolved) demo user.
  await vendo.store.ensureSchema();
  const requestContext = new RequestContext();
  requestContext.set(VENDO_PRINCIPAL_KEY, DEMO_PRINCIPAL);
  // --- /vendo

  const stream = await handleChatStream({
    version: 'v6',
    mastra,
    agentId: 'weather-agent',
    params: { ...params, requestContext },
  });
  return createUIMessageStreamResponse({ stream });
}
