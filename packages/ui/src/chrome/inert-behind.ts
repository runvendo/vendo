/**
 * Make everything BEHIND a body-level Vendo surface inert, and put it back.
 *
 * Both of the surfaces that escape to `document.body` need this: the overlay
 * panel (a modal dialog) and the mobile takeover page (which covers the host's
 * viewport whole). `position: fixed` plus a scrim stops the mouse; only `inert`
 * stops the keyboard and the screen reader from walking into the host page
 * underneath a surface that is visually covering it.
 *
 * Returns the release function — call it on close AND on unmount-while-open.
 */

/**
 * H-2 — who asked for an element to be inert.
 *
 * THE DEFECT: there was no ownership at all. The second caller SKIPPED an
 * element the first had already inerted (`hasAttribute("inert")` → return), so
 * it never recorded it — and then the FIRST caller's release removed the
 * attribute out from under a surface that was still up. Live sequence: the
 * overlay opens (host inert) → the mobile takeover opens (skips the host, it is
 * already inert) → the overlay closes → the host page is interactive again
 * behind a full-screen takeover, permanently, because nothing will ever set it
 * back.
 *
 * A WeakMap of owner tokens fixes both halves: a later caller ADOPTS what an
 * earlier one inerted, and release only clears an element once the last owner
 * has let go. An element the HOST inerted itself has no owner set, is never
 * adopted, and is never cleared — it was never ours.
 */
const owners = new WeakMap<Element, Set<object>>();

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "TEMPLATE"]);

/**
 * Body-level surfaces that must stay reachable ABOVE a modal one.
 *
 * `[aria-modal="true"]` covers a second dialog (the palette's takeover portal
 * over the overlay panel). It does NOT cover the toast stack: `vendo-toasts`
 * portals its own region to `<body>` with no dialog semantics, so opening the
 * overlay inerted it and every toast raised while the overlay was up —
 * including "waiting on you" asks with an Approve button — became unclickable
 * and unannounced. A Vendo surface that belongs above the modal layer says so
 * with `data-vendo-portal`.
 */
const EXEMPT = '[aria-modal="true"], [data-vendo-portal]';

export function inertBehind(wrapper: Element | null): () => void {
  const { body } = document;
  const token = {};
  const held = new Set<Element>();
  const inert = (child: Element) => {
    if (child === wrapper || SKIP_TAGS.has(child.tagName) || held.has(child)) return;
    if (child.matches(EXEMPT) || child.querySelector(EXEMPT)) return;
    const holders = owners.get(child);
    if (holders !== undefined) {
      // Already inert because ANOTHER Vendo surface asked for it: join the
      // owners rather than skipping, so this caller's release can't drop it.
      holders.add(token);
      held.add(child);
      return;
    }
    // Inert for a reason that is not ours (the host's own). Leave it alone —
    // and never claim it, so we can never un-inert it either.
    if (child.hasAttribute("inert")) return;
    child.setAttribute("inert", "");
    owners.set(child, new Set([token]));
    held.add(child);
  };
  for (const child of Array.from(body.children)) inert(child);
  // ENG-228: body children can also appear WHILE the surface is up — the
  // page/palette takeover portals mount on a breakpoint flip, hosts mint toast
  // portals. The open-time snapshot alone would leave those interactive behind
  // the surface, so keep watching.
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.parentElement === body) inert(node);
      }
    }
  });
  observer.observe(body, { childList: true });
  return () => {
    observer.disconnect();
    for (const element of held) {
      const holders = owners.get(element);
      if (holders === undefined) continue;
      holders.delete(token);
      if (holders.size > 0) continue;
      owners.delete(element);
      element.removeAttribute("inert");
    }
    held.clear();
  };
}
