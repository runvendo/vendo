/**
 * The in-house build: one Claude call, one HTML document, no product.
 *
 * This is the honest shape of "why not just wire the model up ourselves?" — a
 * team that has the same theme, the same tool schemas and the same data, and
 * asks the model for a screen. There is no compile, no Kit and no mount: the
 * document it writes IS the page that is shot and probed, and every floor check
 * after that point is the same code the vendo column faces.
 */
import { streamText } from "ai";
import { HARNESS_CONTRACT } from "./render.js";
import type { Contender, RunOutcome, RunRequest } from "./run.js";
import { worldBlock } from "./vendo.js";
import type { World } from "./world.js";

/** Exactly what the vendo contender receives, as one prompt: the shared world
 *  block — the same design brief the screen assembler is given, and the same
 *  descriptors and responses its tool registry serves — plus the harness
 *  contract every page-writing contender gets, in the same bytes. Nothing about
 *  this column's own shape that the others do not also get, and nothing about
 *  the harness that `claude-code` is not told too. `diy.test.ts` pins both
 *  equalities byte for byte; they are the only reason the columns may be
 *  compared at all. */
export function diySystemPrompt(world: World): string {
  return `Write the screen the user asks for.

${worldBlock(world)}

${HARNESS_CONTRACT}

Return ONE complete working HTML document and nothing else.`;
}

/** A whole document is the unit, and models fence one as often as not. */
const unfence = (text: string): string => /```(?:html)?\n?([\s\S]*?)```/.exec(text)?.[1]?.trim() ?? text.trim();

export function diyDriver(): Contender {
  return { run };
}

async function run({ world, testCase, meter, signal }: RunRequest): Promise<RunOutcome> {
  const result = streamText({
    model: meter.model,
    system: diySystemPrompt(world),
    prompt: testCase.prompt,
    // The case's own budget: a generation whose case has already been recorded
    // is one nobody is waiting for, and it goes on billing until it stops.
    ...(signal === undefined ? {} : { abortSignal: signal }),
  });

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
    // The document IS the artifact: nothing compiles between these bytes and the
    // browser, so it lands once, as `page.html`.
    format: "html",
    ...(delivered ? { artifact: page } : {}),
    blocking: [],
    snapshots,
    // A one-shot document paints nothing until it is whole, so first paint IS
    // the settle. That gap against a column that streams is the measurement.
    ...(delivered ? { firstRenderMs: settledMs } : {}),
    settledMs,
    ...(delivered ? {} : { failure: "the model answered without an HTML document" }),
  };
}
