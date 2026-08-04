/** The center's home shelf (redesign spec §10 pick HB, §14 pick CS2).
 *
 *  The home is greeting · suggestion rows · SHELF · composer, and the shelf is
 *  the marquee: your apps as live tiles — real rendered views, not names — with
 *  asking still first. Day zero there is nothing to render, so the same shelf
 *  advertises what the product does as dashed ghost tiles built from the host's
 *  own starter prompts; tapping one runs the first build, and the ghosts retire
 *  for good the moment an app exists.
 *
 *  The greeting, the suggestion rows and the composer are the thread's own
 *  landing (restyled into rows by the center's stylesheet) — this file is only
 *  the shelf, mounted through VendoThread's `composerAccessory` seam so the
 *  composer stays exactly where it sits in a running conversation.
 */
import type { AppDocument } from "@vendoai/core";
import { useMemo } from "react";
import { useVendoContext } from "../../context.js";
import { useApp } from "../../hooks/use-app.js";
import { useInViewport } from "../../hooks/use-in-viewport.js";
import { AppFrame } from "../../tree/frames.js";
import { defaultSlotSuggestions } from "../discoverability.js";
import { deliverPrefill } from "../overlay-registry.js";
import type { VendoSuggestionCard } from "../thread/index.js";

/** How many live tiles the home carries. The shelf is a marquee, not the Apps
 *  page: each tile is a REAL mounted app (a boot, a poll, sometimes an iframe),
 *  so the home shows the newest few and the Apps door shows everything. */
const SHELF_LIMIT = 4;

/** One tile's inert preview: the app's own surface, mounted through the same
 *  frame every other Vendo surface uses, and made unreachable — the tile's
 *  affordance is "open this", never "use this at 55%".
 *
 *  H16 — a tile pays for itself only once the reader scrolls to it. Every tile is
 *  a REAL mounted app (an `apps.get`, an `apps.open`, sometimes an iframe), and
 *  this component is the ONE place both the home shelf and the Apps grid boot
 *  one, so gating here bounds the whole grid: thirty apps below the fold cost
 *  nothing. The gate is sticky (scrolling back past a live app never tears it
 *  down) and it fails OPEN where IntersectionObserver is missing. */
function TilePreview({ appId }: { appId: string }) {
  const { components } = useVendoContext();
  const { ref, seen } = useInViewport<HTMLSpanElement>();
  const { surface, error, isLoading } = useApp(appId, { enabled: seen });
  // No keepalive and no action handler: a preview must not hold a machine warm
  // (or accept a click) on behalf of an app nobody has opened yet.
  if (surface) return <span ref={ref} className="fl-tile-scale"><AppFrame surface={surface} components={components} /></span>;
  // THREE states hid behind one skeleton: nothing asked for yet (the tile is
  // below the fold and the gate above has booted nothing), a boot in flight,
  // and a boot that FAILED — the last of which sat under a pulsing skeleton
  // forever, promising a view that was never coming. A failed boot says so, in
  // the reader's words (ruling 18 + §16 law 3: no code, no ids). It offers no
  // Try again of its own: the preview is inert by design, and the tile's one
  // affordance already opens the app, where `OpenApp` carries the retry.
  if (error && !isLoading) {
    return (
      <span ref={ref} className="fl-tile-none" data-vendo-preview="failed" role="status">
        This didn’t load.
      </span>
    );
  }
  return <span ref={ref} className="fl-tile-skel" data-vendo-preview={seen ? "loading" : "idle"} />;
}

/**
 * H-4 — `inert`, on BOTH React majors.
 *
 * THE DEFECT: the tile used the bare JSX `inert` attribute. React 19 knows that
 * prop; React 18 — still in this package's peer range (`package.json`
 * peerDependencies: `^18.0.0 || ^19.0.0`) — does not, and drops it with a
 * console warning. On a React 18 host the scaled preview was therefore neither
 * inert nor aria-hidden: a generated view's own buttons and inputs were fully
 * focusable and fully announced, which is the exact axe finding the attribute
 * was introduced to close.
 *
 * A ref callback runs at commit on both majors, so the node carries the real
 * attribute either way. (The one thing it does not do is ride the SSR string —
 * server markup is not interactive, and it is set before the first paint after
 * hydration.)
 */
const inertNode = (node: HTMLElement | null): void => {
  node?.setAttribute("inert", "");
};

/** A live app tile. The preview is `inert` — which both takes it out of the
 *  accessibility tree AND makes everything inside it unfocusable, in one
 *  attribute. `aria-hidden` alone was a lie the keyboard could walk into: a
 *  generated view's own buttons and inputs stayed tabbable inside a subtree
 *  screen readers had been told to ignore (axe aria-hidden-focus, once per
 *  tile). The hit area is one real button over the tile, so assistive tech is
 *  offered exactly one honest action. */
export function AppTile({ app, onOpen, children }: {
  app: AppDocument;
  onOpen(): void;
  /** Secondary actions (the Apps page's change/share/remove row). */
  children?: React.ReactNode;
}) {
  // Not every app HAS a view: an automation is a schedule and a plan, and its
  // `open` refuses ("tree app has no ui payload" — two of Maple's four). Say so
  // instead of mounting a load that will fail three times and leave a skeleton
  // sitting there forever pretending to be a view.
  const viewless = app.ui === undefined;
  return (
    <article className="fl-tile">
      <div className="fl-tile-view" ref={inertNode}>
        {viewless
          ? (
            <span className="fl-tile-none">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="m13 2-9 12h8l-1 8 9-12h-8l1-8Z" />
              </svg>
              {app.trigger === undefined ? "No view" : "Runs in the background"}
            </span>
          )
          : <TilePreview appId={app.id} />}
      </div>
      {/* Nothing to open is nothing to offer: a viewless app's tile is a status
          card, not a dead end that answers a tap with a refusal. */}
      {viewless ? null : (
        // data-vendo-tile: the Apps page returns focus to the tile an app was
        // opened from when the app closes.
        <button type="button" className="fl-tile-hit" data-vendo-tile={app.id} aria-label={`Open ${app.name}`} onClick={onOpen} />
      )}
      <div className="fl-tile-cap">
        <span className="fl-tile-name">{app.name}</span>
        {children}
      </div>
    </article>
  );
}

/** Host starter prompts, normalized. §14: ghost prompts are host-authorable
 *  through the starter-suggestion machinery that already exists — the same
 *  `suggestions` the landing renders — with the generic starters as the
 *  fallback for a host that has not written its own. */
function ghostPrompts(suggestions: (string | VendoSuggestionCard)[] | undefined): VendoSuggestionCard[] {
  const source = suggestions !== undefined && suggestions.length > 0 ? suggestions : defaultSlotSuggestions;
  return source
    .slice(0, 3)
    .map(entry => (typeof entry === "string" ? { title: entry, description: "" } : entry));
}

export interface AppShelfProps {
  apps: AppDocument[];
  /** Opens an app full in the column. */
  onOpen(appId: string): void;
  /** Host starter prompts, for the day-zero ghosts. */
  suggestions?: (string | VendoSuggestionCard)[];
  /** The center's prefill scope, so a ghost's prompt lands in THIS column's
   *  composer (§13 strangers: the center never reaches for the overlay). */
  scope: symbol;
}

export function AppShelf({ apps, onOpen, suggestions, scope }: AppShelfProps) {
  const shelf = useMemo(() => apps.slice(0, SHELF_LIMIT), [apps]);
  if (shelf.length === 0) {
    const ghosts = ghostPrompts(suggestions);
    return (
      <section className="fl-shelf fl-shelf--ghost" aria-label="What you could build">
        {ghosts.map(ghost => (
          <button
            type="button"
            className="fl-tile fl-tile--ghost"
            key={ghost.title}
            onClick={() => deliverPrefill({ prompt: ghost.prompt ?? ghost.title, send: true }, { scope })}
          >
            <span className="fl-tile-skel" aria-hidden="true" />
            <span className="fl-tile-cap">
              <span className="fl-tile-name">{ghost.title}</span>
              <small className="fl-tile-hint">{ghost.description ? `${ghost.description} · ` : ""}tap to build</small>
            </span>
          </button>
        ))}
      </section>
    );
  }
  return (
    <section className="fl-shelf" aria-label="Your apps">
      {shelf.map(app => <AppTile app={app} key={app.id} onOpen={() => onOpen(app.id)} />)}
    </section>
  );
}
