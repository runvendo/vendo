/**
 * The thesys contender — "what if we buy the closest competitor product?".
 *
 * Product against product: this column is Thesys C1 (docs.thesys.dev), a hosted
 * generative-UI API, configured the way its own docs say to configure it. It is
 * handed the same `worldBlock` every other column gets, and the world's tools to
 * CALL while it builds ({@link worldToolSet}) — and NOTHING else: no harness
 * contract, because none of the page's wiring is asked of the model here. Their
 * model answers in their own UI DSL and only their React renderer
 * can read it, so this driver does the mechanical half — bundle the renderer,
 * inline the answer, wire the actions — exactly as `mount.tsx` does it for the
 * vendo column.
 *
 * What that costs the comparison is stated plainly in the README: the system
 * prompt this column really runs on is the vendor's and is unobservable, so it
 * is exempt from the byte-equality prompt test that covers `diy` and
 * `claude-code`. Everything after the bytes land is the same code for every
 * column — the floor, the seam, the probe, the judge and the report.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { VendoTheme } from "@vendoai/apps/contract";
import type { JsonSchema } from "@vendoai/core";
import { generateText, jsonSchema, stepCountIs, tool, type ToolSet } from "ai";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonScript } from "./render.js";
import type { Contender, RunOutcome, RunRequest } from "./run.js";
import { worldBlock } from "./vendo.js";
import { cannedResponse, type World } from "./world.js";

/** Their OpenAI-compatible endpoint. The provider NAME is load-bearing:
 *  `@ai-sdk/openai-compatible` copies extra body fields off
 *  `providerOptions[name]`, so the `metadata` below only reaches the wire
 *  because this string and that key are the same string. */
const PROVIDER = "thesys";

export const thesysProvider = (settings: { apiKey?: string; fetch?: typeof globalThis.fetch }) =>
  createOpenAICompatible({ name: PROVIDER, baseURL: "https://api.thesys.dev/v1/embed", ...settings });

/** Their flat platform fee per API call, added to the pass-through token rates
 *  the price table already carries. $0.002 is the Build plan's per-call rate
 *  (thesys.dev/pricing, read 2026-08-16) — this column is priced under that
 *  plan, because a plan's included calls are a subscription no other column
 *  has and this benchmark does not model one. */
export const THESYS_CALL_USD = 0.002;

/** The world's tools as C1 custom actions, so their model attaches a real action
 *  type and schema'd params to the controls it generates
 *  (docs.thesys.dev/guides/custom-actions). The same derived schemas the vendo
 *  registry serves and both baselines are shown. */
export const customActions = (world: World): Record<string, JsonSchema> =>
  Object.fromEntries(world.tools.map((entry) => [entry.name, entry.descriptor.inputSchema]));

/**
 * The world's tools as tools their model may CALL while it builds — the ordinary
 * OpenAI tools array, which is exactly how their own guide says to hand a C1
 * agent live data (docs.thesys.dev/guides/integrate-data/tool-calling: declare
 * the functions, run the loop, append each result as a `tool` message, and the
 * last turn is the C1 DSL).
 *
 * Without them this column was the one contender that could not see a single
 * value. No contender is handed data in its prompt — a screen fetches its own
 * (`worldBlock`) — and the two agentic columns get `world-tools` in their
 * working directory to look with while they build. Their model has no working
 * directory, so this is that same access through the door their product opens,
 * and it is the difference between a screen built on the world's rows and one
 * invented from the schemas.
 *
 * Answered with `cannedResponse` in the envelope `world-tools` prints, so a tool
 * means the same thing to whoever asks it: the same rows the page's bridge will
 * hand their DSL at render time, and a bare acknowledgement for a write.
 * Arguments are accepted and ignored, exactly as every other door into this
 * world ignores them.
 */
export const worldToolSet = (world: World): ToolSet =>
  Object.fromEntries(
    world.tools.map((entry) => [
      entry.name,
      tool({
        description: entry.descriptor.description,
        inputSchema: jsonSchema(entry.descriptor.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: async () => ({ status: "ok", output: cannedResponse(entry) }),
      }),
    ]),
  );

/** How many turns of that loop this column buys: enough to gather from several
 *  tools and then write the screen, and no more. The case's clock already stops
 *  a driver nobody is waiting for; this stops one that is being answered and
 *  keeps asking, because every step here is a billed call plus the vendor's flat
 *  per-call fee ({@link THESYS_CALL_USD}) on top of it. */
const MAX_STEPS = 6;

/** Their font tokens are CSS `font` shorthands with the family baked into every
 *  one, and these twenty-one are the ones no other token falls back to
 *  (`ThemeProvider` in `@crayonai/react-ui`) — so a face is only expressible by
 *  restating them. The weights and sizes are the vendor's own defaults; only the
 *  family moves. */
const FONT_SCALE: Readonly<Record<string, string>> = {
  fontHeadingLarge: "600 28px/1.15",
  fontHeadingMedium: "600 24px/1.15",
  fontHeadingSmall: "550 18px/1.25",
  fontHeadingExtraSmall: "550 16px/1.25",
  fontBody: "400 16px/1.5",
  fontBodySmall: "400 14px/1.5",
  fontBodyHeavy: "500 16px/1.5",
  fontBodySmallHeavy: "500 14px/1.5",
  fontBodyLink: "400 16px/1.5",
  fontBodyLarge: "400 18px/1.5",
  fontBodyLargeHeavy: "500 18px/1.5",
  fontLabel: "400 16px/1.2",
  fontLabelHeavy: "500 16px/1.2",
  fontLabelLarge: "400 18px/1.2",
  fontLabelLargeHeavy: "500 18px/1.2",
  fontLabelSmall: "400 14px/1.2",
  fontLabelSmallHeavy: "500 14px/1.2",
  fontLabelExtraSmall: "400 12px/1.2",
  fontLabelExtraSmallHeavy: "500 12px/1.2",
  fontLabel2ExtraSmall: "400 10px/1.2",
  fontLabel2ExtraSmallHeavy: "500 10px/1.2",
};

/** Ten steps of one hue, light to dark — the shape `defaultChartPalette` has in
 *  every preset they ship. A `VendoTheme` names ONE accent, so the ramp is mixed
 *  from it toward white and then toward black. Their charts read this token and
 *  fall back to their own blue without it (`paletteFromTheme` in their
 *  `Charts/utils/PalletUtils`), which is what painted a Maple chart in another
 *  product's colour until it was set. */
const chartRamp = (accent: string): string[] => {
  const channels = [1, 3, 5].map((at) => parseInt(accent.slice(at, at + 2), 16));
  return [0.88, 0.7, 0.5, 0.28, 0.1, -0.12, -0.3, -0.48, -0.66, -0.82].map(
    (towards) =>
      `#${channels
        .map((value) => Math.round(value + ((towards > 0 ? 255 : 0) - value) * Math.abs(towards)))
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")}`,
  );
};

/**
 * The world's brand in the vendor's own tokens — best effort, and published so
 * the configuration this column is measured under can be read rather than
 * guessed at.
 *
 * Their `Theme` is undocumented ("a detailed guide … is coming soon") AND
 * unimportable: `@crayonai/react-ui` is `"type": "module"` but ships `.d.ts`
 * whose re-exports carry no file extension, which NodeNext cannot follow — the
 * subpath resolves and offers no members, and their SDK's own `ThemeProviderProps`
 * degrades to `any` for the same reason. So the shape is stated here instead, and
 * every name was checked against the `Theme` interface in their shipped
 * `ThemeProvider/types.d.ts`.
 *
 * It is a mapping and not a translation: their ladder is finer than a
 * `VendoTheme`'s, so anything the world does not name — the wider corner radii,
 * the shadows — keeps their default, and is a difference this column wears
 * honestly.
 */
export function crayonTheme(theme: VendoTheme): Record<string, string | string[]> & { defaultChartPalette: string[] } {
  const family = theme.typography.fontFamily;
  return {
    defaultChartPalette: chartRamp(theme.colors.accent),
    backgroundFills: theme.colors.background,
    containerFills: theme.colors.surface,
    elevatedFills: theme.colors.surfaceRaised ?? theme.colors.surface,
    primaryText: theme.colors.text,
    secondaryText: theme.colors.muted,
    linkText: theme.colors.accent,
    strokeDefault: theme.colors.border,
    interactiveAccent: theme.colors.accent,
    accentPrimaryText: theme.colors.accentText,
    dangerPrimaryText: theme.colors.danger,
    interactiveDestructiveAccent: theme.colors.danger,
    roundedS: theme.radius.small,
    roundedM: theme.radius.medium,
    roundedL: theme.radius.large,
    roundedClickable: theme.radius.small,
    ...Object.fromEntries(Object.entries(FONT_SCALE).map(([token, scale]) => [token, `${scale} ${family}`])),
  };
}

interface Bundled {
  readonly js: string;
  readonly css: string;
}

/** `thesys-mount.tsx` and their stylesheet as one script and one style block.
 *  Built on the first case that needs it and reused for the whole run, so a run
 *  of the other columns never pays for their renderer. */
let bundled: Promise<Bundled> | undefined;

async function bundle(): Promise<Bundled> {
  const result = await build({
    entryPoints: [join(dirname(fileURLToPath(import.meta.url)), "thesys-mount.tsx")],
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    minify: true,
    write: false,
    // Never written — the CSS import makes this a two-output build, and esbuild
    // asks for somewhere to have put them.
    outdir: "thesys",
    // Their renderer pulls in KaTeX, whose stylesheet references sixty-odd font
    // files. They are DROPPED rather than emitted or inlined. Emitting leaves a
    // `url()` the harness aborts, and inlining them as data URLs put 1.5MB of
    // base64 inside the page's one `<style>` — which the judge's SOURCE channel
    // keeps, because that channel drops script bodies and nothing else, so this
    // column alone arrived past the grader's context window (1.69M tokens) and
    // could never be graded. No screen here renders maths, and the world's own
    // face is injected by the harness, so nothing is lost by their absence.
    loader: { ".woff2": "empty", ".woff": "empty", ".ttf": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const text = (extension: string): string =>
    result.outputFiles.find((file) => file.path.endsWith(extension))!.text;
  return { js: text(".js"), css: text(".css") };
}

/** The page this column is judged on: their renderer, their answer and the
 *  world's brand in one self-contained document. The harness then injects the
 *  world's face, the recorder and the settle signal (`authoredPage`), the same
 *  bytes it injects into the documents both baselines write. */
const page = (dsl: string, world: World, built: Bundled): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>genbench</title><style>
html,body{margin:0;padding:0;}
#root{padding:20px;}
${built.css}
</style>
${jsonScript("c1", dsl)}
${jsonScript("crayon-theme", crayonTheme(world.theme))}
</head><body><div id="root"></div>
<script>
// Their renderer calls \`crypto.randomUUID()\`, which a browser only exposes in a
// SECURE context — and a page the shooter builds with \`setContent\` is not one.
// So this is the harness's environment missing an API rather than their product
// misusing one, and it is shimmed here instead of being worked around in their
// code. Counted rather than random on purpose: two runs of the same case then
// produce the same bytes, which is the property every other column has.
(function () {
  var minted = 0;
  crypto.randomUUID ||= function () {
    minted += 1;
    return "00000000-0000-4000-8000-" + String(minted).padStart(12, "0");
  };
})();
</script>
<script>${built.js.replaceAll("</script", "<\\/script")}</script>
</body></html>`;

export function thesysDriver(): Contender {
  return { run };
}

async function run({ world, testCase, meter, signal }: RunRequest): Promise<RunOutcome> {
  const { text } = await generateText({
    model: meter.model,
    system: worldBlock(world),
    prompt: testCase.prompt,
    tools: worldToolSet(world),
    // Their loop, bounded: every step is a call this driver pays for, so the
    // model gets `MAX_STEPS` of them and the last word is whatever it had.
    stopWhen: stepCountIs(MAX_STEPS),
    providerOptions: {
      [PROVIDER]: {
        // `metadata.thesys` is a JSON STRING on the wire, not a nested object
        // (docs.thesys.dev/guides/custom-actions). An object there is accepted
        // and silently ignored, which reads as a model that declines to wire
        // anything up.
        metadata: { thesys: JSON.stringify({ c1_custom_actions: customActions(world) }) },
      },
    },
    // The case's own budget: a generation whose case has already been recorded
    // is one nobody is waiting for, and it goes on billing until it stops.
    ...(signal === undefined ? {} : { abortSignal: signal }),
  });
  const settledMs = meter.elapsedMs();
  // Their whole DSL arrives inside `<content>`, and their renderer paints
  // nothing without it — so an answer without one delivered no screen.
  const artifact = text.includes("<content") ? page(text, world, await (bundled ??= bundle())) : undefined;

  return {
    // The document IS the artifact: their renderer is inlined into it, so
    // nothing compiles between these bytes and the browser.
    format: "html",
    ...(artifact === undefined ? {} : { artifact }),
    blocking: [],
    snapshots: [],
    // The loop and then a page: nothing paints until the whole answer is here,
    // so first paint IS the settle — the same reading `diy` reports.
    ...(artifact === undefined ? {} : { firstRenderMs: settledMs }),
    settledMs,
    // Their tokens pass through at the underlying provider's rates and the run's
    // meter already priced them; the platform's flat per-call fee is this
    // product's alone, so it is added here rather than in the price table — once
    // per call, which is once per step of the tool loop.
    usd: meter.usd() + THESYS_CALL_USD * meter.totals().calls,
    ...(artifact === undefined ? { failure: "the vendor answered without a screen" } : {}),
  };
}
