// @vitest-environment jsdom
/**
 * The sealed bundle's frame, and the ONE door through it.
 *
 * A bundle runs with an OPAQUE origin (`allow-scripts` with no
 * `allow-same-origin`), so postMessage is the only thing it can say to the host
 * and `event.source` is the only thing about it the host can trust. Both halves
 * of that are asserted here: the identity gate on the way in, and the sandbox
 * token list on the frame itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ToolOutcome } from "@vendoai/core";
import { VendoProvider } from "../../src/context.js";
import { defaultVendoTheme } from "../../src/theme.js";
import { AppFrame } from "../../src/tree/index.js";
import { readFrameCall, replyToFrame, sendFrameTheme } from "../../src/tree/frame-bridge.js";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** A real iframe in the document, so `contentWindow` is a real other window. */
function mount(): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  return frame;
}

const posted = (source: Window | null, data: unknown) =>
  new MessageEvent("message", { source: source as MessageEventSource | null, data });

const CALL = { vendo: true, kind: "call", id: "c1", ref: "listAccounts", args: { limit: 2 } };
const OK: ToolOutcome = { status: "ok", output: { rows: [] } };
/** One `.vendo/fonts.css` face, as `vendo sync` inlines it. */
const FACE = "@font-face{font-family:'Maple';src:url(data:font/woff2;base64,d09GMg==) format('woff2')}";
/** The host changing its mind about its own palette, mid-session. */
const REPAINTED = { colors: { ...defaultVendoTheme.colors, accent: "#c0ffee" } };

describe("the frame bridge", () => {
  it("reads a well-formed call from the frame itself", () => {
    const frame = mount();
    expect(readFrameCall(frame, posted(frame.contentWindow, CALL)))
      .toEqual({ id: "c1", ref: "listAccounts", args: { limit: 2 } });
  });

  it("ignores a call from a DIFFERENT window (the identity gate)", () => {
    const frame = mount();
    const other = mount();
    // Well-formed in every respect except who sent it. A second embed, an ad
    // frame, or the host page itself must not be able to speak for this app —
    // the call it makes runs with the VIEWER's own permissions.
    expect(readFrameCall(frame, posted(other.contentWindow, CALL))).toBeUndefined();
    expect(readFrameCall(frame, posted(window, CALL))).toBeUndefined();
    expect(readFrameCall(frame, posted(null, CALL))).toBeUndefined();
    expect(readFrameCall(null, posted(null, CALL))).toBeUndefined();
  });

  it("ignores an unstamped message, a foreign kind, and a malformed envelope", () => {
    const frame = mount();
    const framed = frame.contentWindow;
    for (const data of [
      { ...CALL, vendo: false },
      { kind: "call", id: "c1", ref: "x", args: {} },
      { vendo: true, kind: "resize", height: 400 },
      { vendo: true, kind: "call", ref: "x", args: {} },
      { vendo: true, kind: "call", id: "c1", args: {} },
      { vendo: true, kind: "call", id: 7, ref: "x", args: {} },
      "call",
      null,
    ]) {
      expect(readFrameCall(frame, posted(framed, data)), JSON.stringify(data)).toBeUndefined();
    }
  });

  it("replies to the frame's OPAQUE origin, which only \"*\" matches", () => {
    const frame = mount();
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    replyToFrame(frame, "c1", OK);
    expect(post).toHaveBeenCalledWith({ vendo: true, kind: "result", id: "c1", outcome: OK }, "*");
  });

  it("sends brand tokens and nothing else — only --vendo-* may cross", () => {
    const frame = mount();
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    sendFrameTheme(frame, { "--vendo-color-accent": "#0a7", "--host-secret": "leak", color: "red" });
    expect(post).toHaveBeenCalledWith(
      { vendo: true, kind: "theme", vars: { "--vendo-color-accent": "#0a7" } },
      "*",
    );
  });
});

describe("BundleFrame", () => {
  const surface = { kind: "bundle", entry: "a".repeat(64) } as const;

  it("renders the sealed bundle with an OPAQUE origin: allow-scripts and nothing else", () => {
    render(<AppFrame surface={surface} appId="app_built" />);
    const frame = screen.getByTitle("Vendo app") as HTMLIFrameElement;
    // `allow-same-origin` here would run the app in the HOST's origin, holding
    // host storage, cookies and same-origin APIs — the one security rule.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe(`/api/vendo/apps/app_built/bundle/${surface.entry}`);
  });

  it("sends the host's brand tokens once the frame reports booted", () => {
    render(<AppFrame surface={surface} appId="app_built" />);
    const frame = screen.getByTitle("Vendo app") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");

    window.dispatchEvent(posted(frame.contentWindow, { vendo: true, kind: "booted" }));

    const [theme] = post.mock.calls[0] as [{ kind: string; vars: Record<string, string> }];
    expect(theme.kind).toBe("theme");
    // Injected AT RENDER, never baked into the seal.
    expect(theme.vars["--vendo-font-family"]).toBeTypeOf("string");
    expect(Object.keys(theme.vars).every((name) => name.startsWith("--vendo-"))).toBe(true);
  });

  it("sends the host's own font faces with them, straight off the provider", () => {
    render(
      <VendoProvider fonts={FACE}>
        <AppFrame surface={surface} appId="app_built" />
      </VendoProvider>,
    );
    const frame = screen.getByTitle("Vendo app") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");

    window.dispatchEvent(posted(frame.contentWindow, { vendo: true, kind: "booted" }));

    const [theme] = post.mock.calls[0] as [{ fonts?: string }];
    // `.vendo/fonts.css`, at render — the seal holds none of it.
    expect(theme.fonts).toBe(FACE);
  });

  it("routes a frame call through onAction and posts the outcome back", async () => {
    const onAction = vi.fn(async () => OK);
    render(<AppFrame surface={surface} appId="app_built" onAction={onAction} />);
    const frame = screen.getByTitle("Vendo app") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");

    await act(async () => {
      window.dispatchEvent(posted(frame.contentWindow, CALL));
    });

    // THE ONE DOOR: the same `onAction` the tree surface uses, which the slot
    // binds to `client.apps.call` → the guard, with the viewer's permissions.
    expect(onAction).toHaveBeenCalledWith({ nodeId: "c1", action: "listAccounts", payload: { limit: 2 } });
    expect(post).toHaveBeenCalledWith({ vendo: true, kind: "result", id: "c1", outcome: OK }, "*");
  });

  it("ignores an UNSTAMPED boot claim — the stamp is the protocol, on every branch", () => {
    render(<AppFrame surface={surface} appId="app_built" />);
    const frame = screen.getByTitle("Vendo app") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");

    // Every other branch of this bridge checks `vendo: true`; a frame speaking
    // some other protocol that happens to use the same `kind` key is not this
    // one, and must not be handed the host's brand tokens.
    window.dispatchEvent(posted(frame.contentWindow, { kind: "booted" }));

    expect(post).not.toHaveBeenCalled();
  });

  it("answers a frame call the host REFUSED, so the app is never left waiting", async () => {
    // `callHost` has no timeout on the inner side: a call the host never
    // answers leaves the app's query loading for the life of the page.
    const onAction = vi.fn(async () => { throw new Error("the tool door is down"); });
    render(<AppFrame surface={surface} appId="app_built" onAction={onAction} />);
    const frame = screen.getByTitle("Vendo app") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");

    await act(async () => {
      window.dispatchEvent(posted(frame.contentWindow, CALL));
    });

    const [reply] = post.mock.calls[0] as [{ kind: string; id: string; outcome: ToolOutcome }];
    expect(reply.kind).toBe("result");
    expect(reply.id).toBe("c1");
    expect(reply.outcome.status).toBe("error");
  });

  it("re-sends the theme when the host's palette or fonts change after boot", () => {
    // The seal is content, never brand: the tokens arrive by postMessage. A host
    // that switches to dark AFTER the frame booted gets no second `booted`, so
    // without this the app keeps the palette it was mounted under.
    const view = render(
      <VendoProvider fonts={FACE}>
        <AppFrame surface={surface} appId="app_built" />
      </VendoProvider>,
    );
    const frame = screen.getByTitle("Vendo app") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    window.dispatchEvent(posted(frame.contentWindow, { vendo: true, kind: "booted" }));
    post.mockClear();

    const NEXT = "@font-face{font-family:'Birch';src:url(data:font/woff2;base64,d09GMg==) format('woff2')}";
    view.rerender(
      <VendoProvider fonts={NEXT} theme={REPAINTED}>
        <AppFrame surface={surface} appId="app_built" />
      </VendoProvider>,
    );

    const [theme] = post.mock.calls[0] as [{ kind: string; vars: Record<string, string>; fonts?: string }];
    expect(theme.kind).toBe("theme");
    expect(theme.vars["--vendo-color-accent"]).toBe("#c0ffee");
    expect(theme.fonts).toBe(NEXT);
  });

  it("says nothing to a frame that has NOT booted, however the theme moves", () => {
    // The handshake is the whole reason `booted` exists: a frame with no
    // listener yet is a message landing on nobody.
    const view = render(
      <VendoProvider fonts={FACE}>
        <AppFrame surface={surface} appId="app_built" />
      </VendoProvider>,
    );
    const frame = screen.getByTitle("Vendo app") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");

    view.rerender(
      <VendoProvider fonts={FACE} theme={REPAINTED}>
        <AppFrame surface={surface} appId="app_built" />
      </VendoProvider>,
    );

    expect(post).not.toHaveBeenCalled();
  });

  it("fits the reported height through the shared resize gate", () => {
    render(<AppFrame surface={surface} appId="app_built" />);
    const frame = screen.getByTitle("Vendo app") as HTMLIFrameElement;
    window.dispatchEvent(posted(frame.contentWindow, { vendo: true, kind: "resize", height: 512 }));
    expect(frame.style.height).toBe("512px");
  });
});
