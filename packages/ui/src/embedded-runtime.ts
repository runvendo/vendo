/**
 * The INNER half of an embedded Vendo surface (blueprint §12.3) — every
 * surface that renders inside a host-owned iframe owes the host the same two
 * behaviours, so they share this module rather than each keeping a copy of the
 * protocol.
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
import type { Json, ToolOutcome } from "@vendoai/core";
import { ensureThemeFontStyles } from "./chrome/theme-fonts.js";
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

/** The calls this surface is waiting on an answer to, by their own id. */
const awaiting = new Map<string, (outcome: ToolOutcome) => void>();
let calls = 0;

/**
 * THE ONE DOOR to host data (FINAL SPEC v1). A sealed surface has an opaque
 * origin and no network at all, so this is the only thing it can reach — and
 * what it reaches is the host's guarded tool door, run with the VIEWER's own
 * permissions. Nothing here decides what is allowed; the guard does, and a call
 * the viewer may not make comes back as a refused outcome like any other.
 */
export function callHost(ref: string, args: Json = null): Promise<ToolOutcome> {
  const id = `call_${(calls += 1)}`;
  return new Promise((resolve) => {
    awaiting.set(id, resolve);
    postToHost({ kind: "call", id, ref, args });
  });
}

/**
 * The host's half of the protocol, received. `event.source` is the gate on this
 * side too — only the window that embedded this surface may theme it or answer
 * for it, and that is the one thing a sender cannot forge.
 */
function receiveFromHost(event: MessageEvent): void {
  if (event.source !== parent) return;
  const message = event.data as
    { vendo?: unknown; kind?: unknown; vars?: unknown; fonts?: unknown; id?: unknown; outcome?: unknown } | null;
  if (typeof message !== "object" || message === null || message.vendo !== true) return;
  if (message.kind === "theme") {
    applyThemeVars(message.vars);
    // The brand's own faces, as `data:` URIs — the family token names a font
    // this document would otherwise have no bytes for. Same installer the
    // chrome uses, so a surface that is its own document gets its own sheet.
    if (typeof message.fonts === "string") ensureThemeFontStyles(message.fonts);
  }
  if (message.kind === "result" && typeof message.id === "string") {
    awaiting.get(message.id)?.(message.outcome as ToolOutcome);
    awaiting.delete(message.id);
  }
}

const VIEWPORT_BLOCK_UNIT = /(?:d|s|l)?v(?:h|b)(?![a-z])/iu;
const VIEWPORT_BLOCK_PROPERTIES = ["height", "min-height", "block-size", "min-block-size"] as const;

/**
 * Start the frame protocol on `mount`: normalize viewport-relative block
 * constraints, report the content height on every content change, and announce
 * `booted` once the observers are live.
 *
 * Messages out: `{ vendo: true, kind: "resize", height }`,
 * `{ vendo: true, kind: "booted" }`, and one `{ kind: "call" }` per
 * {@link callHost}. In: `theme` and `result`.
 */
export function startFrameProtocol(mount: HTMLElement, post = postToHost): void {
  // Before `booted`: the host answers that announcement with the brand tokens,
  // so a listener installed after it would miss them.
  addEventListener("message", receiveFromHost);
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
