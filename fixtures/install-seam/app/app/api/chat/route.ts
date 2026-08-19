import { vendoTools } from "@vendoai/vendo/ai-sdk";
import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { scriptedModel, type TurnSpec } from "../../../lib/scripted-model";
// `vendo` is what `vendo init` writes into lib/vendo.ts. The import exists
// before init runs — this app is the existing-agent quickstart's starting
// point, where the loop is already there and Vendo's composition is the piece
// init supplies.
import { vendo } from "@/lib/vendo";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The demo principal init's anonymous composition resolves. Both sides must
 *  name the same subject, or what chat creates is invisible to the embeds. */
const demoUser = { kind: "user", subject: "demo-user" } as const;

/**
 * This app's own agent loop — the AI SDK quickstart shape, plus the one touch
 * the existing-agent quickstart asks for: spread `vendoTools` into the loop's
 * tools so every host call routes through policy → execution → audit.
 *
 * The model's moves arrive in the request body (see lib/scripted-model.ts);
 * everything downstream of them is the real thing.
 */
export async function POST(req: Request): Promise<Response> {
  const { messages, script } = (await req.json()) as { messages: UIMessage[]; script: TurnSpec[] };

  const result = streamText({
    model: scriptedModel(script),
    messages: await convertToModelMessages(messages),
    stopWhen: stepCountIs(5),
    tools: await vendoTools(vendo, { principal: demoUser }),
  });

  return result.toUIMessageStreamResponse();
}
