/**
 * Spec 2026-08-05 §2/§3 — the [Context] channel's CLIENT half: what the
 * user's screen shows (an aria-snapshot of the visible host page, URL + title
 * prepended) plus any data the host published through useVendoContext,
 * merged per send and attached to the POST /threads body. Current-turn only by
 * construction — it rides the request, never the transcript.
 */
import { ariaSnapshot } from "aria-snapshot";

/** Decision 3: the client never sends a snapshot over ~8 KB; truncation
    prefers main content (see captureScreen). The server enforces the same cap
    on whatever arrives. */
const SNAPSHOT_CAP = 8192;

/** Hosts opt an element (and its children) out of capture. The widget's own
    chrome roots carry it too (decision 4 — the widget excludes itself). */
const IGNORE_SELECTOR = "[data-vendo-ignore]";

/** Appended in place of what a hard truncation dropped. Its own length is the
    budget floor below which there is no room to say anything at all. */
const TRUNCATION_MARKER = "\n…[truncated]";

const published = new Map<symbol, Record<string, unknown>>();

/** useVendoContext's write half: one entry per mounted hook instance. */
export function publishSituation(key: symbol, data: Record<string, unknown>): void {
  published.set(key, data);
}

export function retireSituation(key: symbol): void {
  published.delete(key);
}

/** aria-snapshot has no exclusion option, but its walk prunes aria-hidden
    subtrees — so ignored elements are hidden for exactly the duration of the
    SYNCHRONOUS walk. No paint can happen inside one JS task, so nothing
    flickers, and each element's own aria-hidden value is restored verbatim. */
function snapshotExcludingIgnored(root: Element): string {
  const previous = new Map<Element, string | null>();
  for (const element of document.querySelectorAll(IGNORE_SELECTOR)) {
    previous.set(element, element.getAttribute("aria-hidden"));
    element.setAttribute("aria-hidden", "true");
  }
  try {
    return ariaSnapshot(root);
  } finally {
    for (const [element, was] of previous) {
      if (was === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", was);
    }
  }
}

/** URL + title, then the page's accessibility tree (aria-snapshot handles
    visibility). Over budget, main content first: retry from <main> alone,
    then hard-truncate with an honest marker. */
export function captureScreen(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const header = `${document.location.href}\n${document.title}`;
  const budget = SNAPSHOT_CAP - header.length - 1;
  // A budget under the marker's own length would make `budget - marker` a
  // NEGATIVE slice end, which counts from the end of the tree and would keep
  // nearly all of it — so a header that leaves no room goes out on its own.
  if (budget <= TRUNCATION_MARKER.length) return header.slice(0, SNAPSHOT_CAP);
  let tree = snapshotExcludingIgnored(document.body);
  if (tree.length > budget) {
    const main = document.querySelector("main");
    if (main !== null) tree = snapshotExcludingIgnored(main);
  }
  if (tree.length > budget) {
    tree = `${tree.slice(0, budget - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
  }
  return `${header}\n${tree}`;
}

/** The merged situation for ONE send: published host data (publish order,
    later entries win a repeated key), then the screen. Undefined when there is
    nothing to say — the POST body then carries no `context` at all. */
export function currentSituation(capture: boolean): Record<string, unknown> | undefined {
  const data: Record<string, unknown> = {};
  for (const entry of published.values()) Object.assign(data, entry);
  const screen = capture ? captureScreen() : undefined;
  if (screen !== undefined) data["screen"] = screen;
  return Object.keys(data).length > 0 ? data : undefined;
}
