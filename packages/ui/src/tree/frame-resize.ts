/**
 * The frame resize protocol — ONE implementation, both frames.
 *
 * Every Vendo iframe (the served app's http frame, the box app template) lets a
 * document the host cannot see report its own natural height. The identity gate
 * is the security half of that, and a second copy of a security gate is a
 * second gate to get wrong — so the gate, the message validation, and the clamp
 * live here and nowhere else.
 *
 * The wire: the framed document posts `{ vendo: true, kind: "resize", height }`
 * to its parent (`postToHost` in embedded-runtime.ts stamps every message), and
 * the host fits the frame to it.
 */

/**
 * The ceiling a host that configures nothing gets, kept to the pixel so no
 * shipped host's behaviour changes.
 */
export const DEFAULT_FRAME_MAX_HEIGHT = 8_192;

/** The absolute floor: a frame is never sized away entirely. */
const MIN_FRAME_HEIGHT = 1;

/** A resolved absolute length. Anything else (`auto`, `none`, a percentage of an
 *  auto-height parent, an unresolved `var()`) is not a bound we can honour. */
const RESOLVED_PIXELS = /^(\d+(?:\.\d+)?)px$/;

function resolvedPixels(value: string | undefined): number | undefined {
  const match = RESOLVED_PIXELS.exec((value ?? "").trim());
  return match === null ? undefined : Number(match[1]);
}

/**
 * The identity gate. `event.source` is the window that actually sent the
 * message, and it is the one thing a sender cannot forge — only the frame we
 * rendered may speak for that frame. Every other window (the host page, another
 * embed, an ad frame, an opener) is ignored in silence.
 */
export function isFromFrame(frame: HTMLIFrameElement | null, event: MessageEvent): boolean {
  const framed = frame?.contentWindow;
  return framed !== null && framed !== undefined && event.source === framed;
}

/** The reported natural height, or `undefined` for anything that is not a
 *  well-formed, Vendo-stamped resize report. */
function reportedHeight(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as Record<string, unknown>;
  if (message.vendo !== true || message.kind !== "resize") return undefined;
  const { height } = message;
  return typeof height === "number" && Number.isFinite(height) ? height : undefined;
}

/**
 * THE HOST'S BOUNDS WIN. The host sized the slot when it embedded Vendo; that is
 * a constraint the app lives inside, never overrides. The app *reports* its
 * natural height and the frame fits that height within the host's min/max — an
 * app taller than the host allows scrolls inside its own frame (an iframe scrolls
 * its own document) instead of pushing the host's layout.
 *
 * Both bounds are read back off the frame's own RESOLVED style, so the host
 * states them in CSS — `--vendo-app-frame-height` / `--vendo-jail-min-height`
 * for the floor, `--vendo-app-frame-max-height` for the ceiling, or plain
 * `min-height`/`max-height` on the frame — in whatever unit it likes, and the
 * browser resolves the unit. This module never parses `rem`, `vh`, or `calc()`.
 */
function clampToHostBounds(frame: HTMLIFrameElement, height: number): number {
  const computed = frame.ownerDocument.defaultView?.getComputedStyle(frame);
  const min = resolvedPixels(computed?.minHeight) ?? MIN_FRAME_HEIGHT;
  const max = resolvedPixels(computed?.maxHeight) ?? DEFAULT_FRAME_MAX_HEIGHT;
  // `max(min, min(max, h))` is the cascade's own order — CSS lets min-height win
  // a conflict with max-height. Clamping the other way round would make the
  // height we write a lie about the box the browser actually lays out.
  return Math.max(min, Math.min(max, height));
}

/**
 * The one resize handler both frames install: identity gate, then validation,
 * then the host's bounds, then apply. Returns whether the frame was resized, so
 * a caller with other message kinds can use it as an arm of its own chain.
 */
export function applyFrameResize(frame: HTMLIFrameElement | null, event: MessageEvent): boolean {
  if (!isFromFrame(frame, event) || frame === null) return false;
  const height = reportedHeight(event.data);
  if (height === undefined) return false;
  frame.style.height = `${clampToHostBounds(frame, height)}px`;
  return true;
}

/**
 * The ceiling declaration both frames carry. It is load-bearing CSS (the browser
 * enforces it whatever height we write) and it is what `clampToHostBounds` reads
 * back, so the host has exactly one place to change: the custom property.
 */
export const FRAME_MAX_HEIGHT_CSS = `var(--vendo-app-frame-max-height, ${DEFAULT_FRAME_MAX_HEIGHT}px)`;
