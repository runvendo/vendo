/**
 * The postMessage bridge to a SEALED bundle — the one door between a built app
 * and the host (FINAL SPEC v1).
 *
 * A bundle frame is sandboxed `allow-scripts` with no `allow-same-origin`, so
 * its origin is OPAQUE: it can reach nothing of the host's, it can make no
 * network request of its own (`default-src 'none'`), and postMessage is the
 * only thing it can say. Which makes this module the whole attack surface, so
 * it holds exactly three moves and no policy of its own:
 *
 *  - `readFrameCall` — what came in, and only if the frame we rendered sent it.
 *    The identity gate is `isFromFrame`, shared with the resize protocol,
 *    because a second copy of a security gate is a second gate to get wrong.
 *  - `replyToFrame` — the outcome of that call, back.
 *  - `sendFrameTheme` — the host's brand tokens, at render.
 *
 * What a call is ALLOWED to do is decided nowhere near here: the frame's call
 * rides `AppFrameProps.onAction` → `client.apps.call` → the guard, with the
 * viewer's own permissions, exactly as a tree surface's press does.
 */
import type { Json, ToolOutcome } from "@vendoai/core";
import { isFromFrame } from "./frame-resize.js";

/** One call a framed bundle is making of the host. `id` is the frame's own
 *  correlation token, echoed back on the result and nothing more. */
export interface FrameCall {
  id: string;
  ref: string;
  args: Json;
}

/** Only `--vendo-*` custom properties may cross into an embedded surface (06 §5)
 *  — filtered on the way OUT as well as on the way in, so a host token that is
 *  not brand vocabulary never leaves the page. */
const VENDO_VAR = /^--vendo-[a-z0-9-]+$/;

/**
 * Every message out goes to `"*"`. That is not laxity: an opaque origin
 * serializes to "null" and matches no `targetOrigin` but the wildcard, so a
 * stricter value here would silently deliver nothing. Nothing secret travels
 * this way — a result the frame's own call earned, and the brand tokens.
 */
function postToFrame(frame: HTMLIFrameElement | null, message: Record<string, unknown>): void {
  frame?.contentWindow?.postMessage({ vendo: true, ...message }, "*");
}

/** The inbound call, or `undefined` for anything that is not a well-formed,
 *  Vendo-stamped call from THIS frame. */
export function readFrameCall(frame: HTMLIFrameElement | null, event: MessageEvent): FrameCall | undefined {
  if (!isFromFrame(frame, event)) return undefined;
  const data = event.data as Record<string, unknown> | null;
  if (typeof data !== "object" || data === null || data.vendo !== true || data.kind !== "call") return undefined;
  const { id, ref, args } = data;
  if (typeof id !== "string" || typeof ref !== "string") return undefined;
  return { id, ref, args: (args ?? null) as Json };
}

/** The outcome of one call, back to the frame that made it. */
export function replyToFrame(frame: HTMLIFrameElement | null, id: string, outcome: ToolOutcome): void {
  postToFrame(frame, { kind: "result", id, outcome });
}

/**
 * The host's brand tokens and font faces, injected AT RENDER — never baked into
 * the seal, so one sealed bundle follows whatever palette the host is wearing
 * today.
 *
 * `fonts` is the host's `.vendo/fonts.css` (`VendoContextValue.fonts`), whose
 * faces sync already inlined as `data:` URIs. The family NAME alone is useless
 * here: the frame has an opaque origin the host's stylesheet never reaches, so
 * without the bytes the token resolves to whatever the frame happens to have.
 * Absent, the token's own fallback stack is the whole answer — the route's CSP
 * (`font-src data:`) blocks any face that would try to fetch anything.
 */
export function sendFrameTheme(frame: HTMLIFrameElement | null, vars: Record<string, string>, fonts?: string): void {
  postToFrame(frame, {
    kind: "theme",
    vars: Object.fromEntries(Object.entries(vars).filter(([name]) => VENDO_VAR.test(name))),
    ...(fonts === undefined || fonts === "" ? {} : { fonts }),
  });
}
