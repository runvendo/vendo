/**
 * The in-house build: one Claude call, one HTML document, no product.
 *
 * This is the honest shape of "why not just wire the model up ourselves?" — a
 * team that has the same theme, the same tool schemas and the same data, and
 * asks the model for a screen. There is no compile, no Kit and no mount: the
 * document it writes IS the page that is shot and probed, and every floor check
 * after that point is the same code the vendo column faces.
 */
import { hostDesignBrief } from "@vendoai/apps";
import { streamText } from "ai";
import type { Contender, RunOutcome, RunRequest } from "./run.js";
import { designRules } from "./vendo.js";
import { cannedResponse, type World } from "./world.js";

/** Exactly what the vendo contender receives, as one prompt: the same design
 *  brief the screen assembler is given, and the same descriptors and responses
 *  its tool registry serves. `diy.test.ts` pins that equality byte for byte —
 *  it is the only reason the two columns may be compared at all. */
export function diySystemPrompt(world: World): string {
  const tools = world.tools
    .map((tool) => `${JSON.stringify(tool.descriptor, null, 2)}\nreturns: ${JSON.stringify(cannedResponse(tool), null, 2)}`)
    .join("\n\n");
  return `Write the screen the user asks for.

${hostDesignBrief({ theme: world.theme, designRules: designRules(world) })}

HOST TOOLS — call one from the page with \`vendo.callTool(name, args)\`. It is
already on \`window\`, and it answers with { status: "ok", output: <the value
shown under \`returns\`> } or { status: "error", error: { code, message } }.

${tools}

Return ONE complete working HTML document and nothing else: self-contained,
inline CSS and inline JS, no build step and no network requests.`;
}

/** A whole document is the unit, and models fence one as often as not. */
const unfence = (text: string): string => /```(?:html)?\n?([\s\S]*?)```/.exec(text)?.[1]?.trim() ?? text.trim();

export function diyDriver(): Contender {
  return { harness: "diy", run };
}

async function run({ world, testCase, meter }: RunRequest): Promise<RunOutcome> {
  const result = streamText({ model: meter.model, system: diySystemPrompt(world), prompt: testCase.prompt });

  const snapshots: Array<{ atMs: number }> = [];
  let answer = "";
  for await (const chunk of result.textStream) {
    answer += chunk;
    snapshots.push({ atMs: meter.elapsedMs() });
  }
  const settledMs = meter.elapsedMs();

  const page = unfence(answer);
  const delivered = /<html[\s>]|<!doctype html/i.test(page);
  return {
    ...(delivered ? { page } : {}),
    blocking: [],
    snapshots,
    // A one-shot document paints nothing until it is whole, so first paint IS
    // the settle. That gap against a column that streams is the measurement.
    ...(delivered ? { firstRenderMs: settledMs } : {}),
    settledMs,
    ...(delivered ? {} : { failure: "the model answered without an HTML document" }),
  };
}
