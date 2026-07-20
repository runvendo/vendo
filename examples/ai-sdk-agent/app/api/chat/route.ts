import { anthropic } from "@ai-sdk/anthropic";
import { convertToModelMessages, stepCountIs, streamText, UIMessage } from "ai";
// --- vendo: the guarded tool pack for AI SDK loops
import { vendoTools } from "@vendoai/vendo/ai-sdk";
import { demoUser, vendo } from "@/lib/vendo";
// --- /vendo

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: anthropic("claude-sonnet-4-6"),
    messages: await convertToModelMessages(messages),
    stopWhen: stepCountIs(5),
    tools: {
      // --- vendo: the quickstart's inline `weather` tool moved into the pack as
      // `vendo_host_get_weather` (lib/vendo.ts), so every call routes through
      // policy → approval → audit. The spread also adds `vendo_host_send_trip_report`
      // (parks for approval), `vendo_create_app` (generated UI), and `vendo_delegate`.
      ...(await vendoTools(vendo, { principal: demoUser })),
      // --- /vendo
    },
  });

  return result.toUIMessageStreamResponse();
}
