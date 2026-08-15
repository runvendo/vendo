/**
 * The INNER half of an embedded Vendo surface (blueprint §12.3) — the box app
 * template (`packages/box-template`) and every other surface that renders
 * inside a host-owned iframe owe the host the same two behaviours, so they
 * share this module rather than each keeping a copy of the protocol.
 *
 * Both jobs are RECEIVING or REPORTING, never negotiating:
 *
 *  - `applyThemeVars` receives the host's brand tokens. Only `--vendo-*` custom
 *    properties may cross into the surface (06 §5).
 *  - `startFrameProtocol` reports the surface's natural content height to the
 *    embedding frame, then announces `booted`.
 *
 * THE HOST'S BOUNDS WIN (founder ruling 2026-08-04). The host sized the slot
 * when it embedded Vendo; that is a constraint the app lives inside, never
 * overrides. This module only ever REPORTS a natural height — it holds no code
 * that sets or negotiates its own size against the host, and must never grow
 * any. An app taller than the host allows scrolls inside its own frame; it never
 * pushes the host's layout. The clamp is the host's, and so is the min/max the
 * host configured.
 */
import { normalizeViewportBlockCss } from "./tree/viewport-css.js";

/** Post one message to the embedding host. Every message is stamped `vendo: true`
 *  — that stamp is how the host tells a Vendo surface's messages from any other
 *  frame's, so it is part of the protocol and not an implementation detail. */
export function postToHost(message: Record<string, unknown>): void {
  parent.postMessage({ vendo: true, ...message }, "*");
}

/** Host brand tokens: only --vendo-* custom properties may cross into an
    embedded surface, so generated code styled with the theme variables matches
    the host (06 §5). */
export function applyThemeVars(vars: unknown): void {
  if (typeof vars !== "object" || vars === null) return;
  const rootStyle = document.documentElement.style;
  for (const [key, value] of Object.entries(vars as Record<string, unknown>)) {
    if (typeof value === "string" && /^--vendo-[a-z0-9-]+$/.test(key)) {
      rootStyle.setProperty(key, value);
    }
  }
  document.body.style.fontFamily = "var(--vendo-font-family, system-ui, sans-serif)";
  document.body.style.color = "var(--vendo-color-text, #16161a)";
  document.body.style.fontSize = "var(--vendo-font-size, 15px)";
}

const VIEWPORT_BLOCK_UNIT = /(?:d|s|l)?v(?:h|b)(?![a-z])/iu;
const VIEWPORT_BLOCK_PROPERTIES = ["height", "min-height", "block-size", "min-block-size"] as const;

/**
 * Start the frame protocol on `mount`: normalize viewport-relative block
 * constraints, report the content height on every content change, and announce
 * `booted` once the observers are live.
 *
 * Messages out: `{ vendo: true, kind: "resize", height }` and
 * `{ vendo: true, kind: "booted" }`. Nothing else, ever.
 */
export function startFrameProtocol(mount: HTMLElement, post = postToHost): void {
  let lastReportedHeight: number | undefined;
  let mutationObserver: MutationObserver | undefined;

  function contentHeight(): number {
    const elements = [mount, ...mount.querySelectorAll<HTMLElement>("[style]")];

    // A generated root commonly uses min-height:100vh. Inside an auto-sized
    // iframe, that makes its "content" depend on the previous host height. An
    // auto-height surface has no independent block viewport, so normalize
    // viewport-relative block constraints to their content-sized forms —
    // inline styles here, and the same constraint arriving in a <style> tag
    // (generated islands ship those too) via the stylesheet-text arm below.
    for (const element of elements) {
      for (const property of VIEWPORT_BLOCK_PROPERTIES) {
        const value = element.style.getPropertyValue(property);
        if (!VIEWPORT_BLOCK_UNIT.test(value)) continue;
        element.style.setProperty(property, property.startsWith("min-") ? "0" : "auto", "important");
      }
    }
    for (const sheet of document.querySelectorAll("style")) {
      const css = sheet.textContent ?? "";
      const normalized = normalizeViewportBlockCss(css);
      if (normalized !== css) sheet.textContent = normalized;
    }

    const height = Math.ceil(Math.max(mount.getBoundingClientRect().height, mount.scrollHeight));
    // Attribute observation catches state-driven constraint changes. Discard
    // the normalization mutations themselves so they cannot loop.
    mutationObserver?.takeRecords();
    return height;
  }

  function reportContentHeight(): void {
    const height = contentHeight();
    if (height === lastReportedHeight) return;
    lastReportedHeight = height;
    post({ kind: "resize", height });
  }

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(reportContentHeight);
    // The mount changes for content growth; observing viewport-owned html/body
    // would reintroduce the host/frame feedback path.
    observer.observe(mount);
  }

  if (typeof MutationObserver !== "undefined") {
    mutationObserver = new MutationObserver(reportContentHeight);
    // React can add a new viewport constraint without changing the current box,
    // so also react to render mutations and normalize before measuring.
    mutationObserver.observe(mount, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

  post({ kind: "booted" });
}
