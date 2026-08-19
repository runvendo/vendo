/**
 * The browser half of a benchmark page: the PRODUCT's own renderer, mounted the
 * way a host mounts it, with one recorder standing in for the host's tools.
 * Bundled once per run by `render.ts` and inlined into every page.
 */
import {
  type Json,
  type ToolOutcome,
  type UIPayload,
} from "@vendoai/core";
import {
  bootScreen,
  defaultVendoTheme,
  flattenTree,
  KIT_COMPONENT_NAMES,
  queryKey,
  resolveTheme,
  ScreenError,
  themeCssVariables,
  warmScreenEngine,
  type ScreenInstance,
  type ScreenQuery,
  type VendoTheme,
} from "@vendoai/apps/contract";
import { VendoProvider } from "@vendoai/ui";
import { applyThemeVars } from "@vendoai/ui/kit";
import { PayloadView } from "@vendoai/ui/tree";
import { useEffect, type JSX } from "react";
import { createRoot } from "react-dom/client";

/**
 * The engine build THIS page runs on, pinned rather than defaulted.
 *
 * The harness contract's first rule is SELF-CONTAINED — the page is opened with
 * no network at all — and `render.ts` bundles it as ONE esbuild IIFE, where
 * `import.meta` is empty. The stock build fetches its WebAssembly as an emitted
 * asset, and neither half of that exists here. The SINGLE-FILE build carries the
 * bytes inside the JavaScript, which is the one thing this page can hold; the
 * string it embeds is unparseable after SWC re-quotes it (#1496) and perfectly
 * fine after esbuild, and esbuild is the only bundler this page ever sees.
 *
 * Pinned at module scope so it is ONE stable key: `warmScreenEngine` memoizes on
 * the variant, and an explicitly passed one wins over every later default warm —
 * including `PayloadView`'s own, which asks for no variant.
 */
const PAGE_ENGINE = import("@jitl/quickjs-singlefile-browser-release-sync");

declare global {
  interface Window {
    /** The one seam every contender's page answers through, injected by
     *  `render.ts` into hand-written and product-rendered pages alike. The
     *  renderer's action dispatch is wired to it below. */
    vendo: {
      calls: Array<{ name: string; args: Json }>;
      callTool(name: string, args: Json): ToolOutcome;
    };
    /** Set once the tree has committed and had two frames to draw. */
    __settled?: boolean;
  }
}

const read = <T,>(id: string): T => JSON.parse(document.getElementById(id)!.textContent!) as T;

const theme = read<VendoTheme>("theme");
applyThemeVars(themeCssVariables(resolveTheme(defaultVendoTheme, theme)));
const served = read<UIPayload>("payload");

/**
 * A component screen's live half, exactly as the paint gate wrote it into the
 * payload (`apps/src/server/checking/floor.ts:240`): the compiled module, the
 * answers it was painted against, and how to read them again.
 */
interface Interactive {
  readonly compiledSource: string;
  readonly queries: Record<string, unknown>;
  readonly queryPlan?: readonly { tool: string; input?: Json }[];
}

const interactive = (served as { interactive?: Interactive }).interactive;

/** Times the screen may ask for another read before the open stops answering —
 *  the same bound the save gate and the renderer keep. */
const MAX_SUPPLY_ROUNDS = 3;

/**
 * The payload as an OPEN produces it: the screen RUN — here, now — against the
 * answers this host gives this page.
 *
 * A deployment never serves the paint it saved. `runtime.open` hands the app's
 * own `app.tsx` back through the same gauntlet a save paints through, so the
 * payload a person is served is the screen re-executed against the queries their
 * open just made (`apps/src/server/persistence/open.ts:229`, and the comment on
 * `createAppOpener`'s `screen` argument says so in the product's own words). A
 * benchmark page has no server behind it — it is one file carrying one payload,
 * frozen at the instant the assembler wrote it — so unless the open happens
 * HERE, the vendo column ships the one thing this product says a screen is not:
 * a snapshot. It measured as one, on 10% of its displayed values and dead last
 * of seven columns (the liveness axis, 2026-08-17).
 *
 * The same engine and the same two calls the server makes, in the same order:
 * read the plan, boot the compiled module on the answers, flatten the paint. A
 * screen that declared no queries has nothing to re-read and is served exactly
 * as it was — it is static because it asked for nothing, which is the one honest
 * way to be.
 */
async function opened(): Promise<UIPayload> {
  if (interactive === undefined) return served;
  // Warmed for EVERY interactive payload, including one with nothing to re-read.
  // The engine's WebAssembly is the one asynchronous thing between mount and a
  // live screen, and `PayloadView` boots its own VM off this same warmed module
  // (`ui/src/tree/screen-engine.ts`) — so awaiting it here is what lets the
  // settle signal below be two frames rather than a guess at how long a VM takes.
  await warmScreenEngine(PAGE_ENGINE);
  const plan = interactive.queryPlan ?? [];
  if (plan.length === 0) return served;
  const answer = (asks: readonly ScreenQuery[]): Record<string, unknown> => Object.fromEntries(asks.map((query) => {
    const outcome = window.vendo.callTool(query.tool, (query.input ?? {}) as Json);
    // A read that failed leaves its key absent, which is what the renderer's own
    // re-read does with one (`ui/src/tree/use-screen.ts`) — the screen renders
    // that query empty rather than the page rendering nothing.
    return [queryKey(query), outcome.status === "ok" ? outcome.output : undefined];
  }));
  const queries = answer(plan);
  const boot = (): ScreenInstance => bootScreen({
    compiledSource: interactive.compiledSource,
    queries,
    // Exactly the renderer's own vocabulary — `StatefulTreeView` boots its VM
    // with `[...KIT_COMPONENT_NAMES, ...components]` and nothing here registers
    // a host component, so this is the same list the checks floor admitted.
    catalog: KIT_COMPONENT_NAMES,
    now: Date.now(),
  });
  // A boot that threw while it was still waiting on a read threw against answers
  // this page had not given it yet — a loading paint, not a broken screen. Answer
  // what it named and boot again, the same law the save gate keeps.
  let screen: ScreenInstance;
  for (let round = 1; ; round += 1) {
    try {
      screen = boot();
      break;
    } catch (error) {
      const asks = error instanceof ScreenError ? error.misses : [];
      if (asks.length === 0 || round === MAX_SUPPLY_ROUNDS) throw error;
      Object.assign(queries, answer(asks));
    }
  }
  try {
    // A read whose input the screen computes is named by the paint, not by the
    // plan, so the open answers what the screen asks for until it stops asking —
    // the same loop the save gate and the renderer run.
    for (let round = 0; round < MAX_SUPPLY_ROUNDS; round += 1) {
      const misses = screen.misses();
      if (misses.length === 0) break;
      Object.assign(queries, answer(misses));
      screen.supply(queries);
    }
    const flat = flattenTree(screen.tree());
    // The fresh answers travel with the tree: the VM `PayloadView` boots for the
    // screen's HANDLERS reads `interactive.queries`, and a handler working off
    // the rows the assembler saw while the tree beside it shows today's is two
    // screens in one.
    return {
      ...served,
      nodes: Object.values(flat.nodes),
      root: flat.root,
      interactive: { ...interactive, queries },
    } as unknown as UIPayload;
  } finally {
    screen.dispose();
  }
}

function Screen({ payload }: { payload: UIPayload }): JSX.Element {
  /**
   * Two frames after the commit, for every payload there is — the Kit's charts
   * size themselves off a ResizeObserver, so the frame that mounts one is never
   * the frame that draws it.
   *
   * An interactive screen used to be given a flat extra second here, because the
   * one asynchronous thing it was waiting on — the engine behind `PayloadView`'s
   * own VM — could not be waited on from out here. It can now: `opened()` awaits
   * exactly that engine before this ever renders, and the tree that mounts is
   * already the finished paint rather than a skeleton the VM replaces. What is
   * left for the VM to do is arm the `{$handler}` props, and the bridge HOLDS a
   * press that lands before it is up and delivers it on boot
   * (`ui/src/tree/use-screen.ts:224`), so the probe cannot lose one to the gap.
   *
   * That second was worth deleting because bind-by-default routes EVERY vendo
   * case through this path: a fixed sleep here is a tax on the whole column, and
   * one paid three times per case now that liveness paints each page twice more.
   */
  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.__settled = true;
      });
    });
  }, []);
  // The provider is where a host declares its brand, and the renderer's surface
  // re-emits every `--vendo-*` from the theme it reads there — defaulting to the
  // product's own neutral one when nobody provided it (renderer.tsx:805, 1016).
  // So the root variables `applyThemeVars` set above are shadowed inside the
  // screen: without this, every vendo-column page painted accent #111111 on a
  // world that declares brand green, and was graded down for it.
  return (
    <VendoProvider theme={theme}>
      <PayloadView
        payload={payload}
        components={{}}
        data={(payload as { data?: Record<string, Json> }).data}
        onAction={async ({ action, payload: args }) => window.vendo.callTool(action, args ?? {})}
      />
    </VendoProvider>
  );
}

// The open is asynchronous (the engine's WebAssembly loads once), so the mount
// is too. Nothing paints before it: a served tree painted first and swapped a
// beat later is a race the shot can lose, and losing it means grading the very
// snapshot this page exists to stop shipping.
void opened().then((payload) => createRoot(document.getElementById("root")!).render(<Screen payload={payload} />));
