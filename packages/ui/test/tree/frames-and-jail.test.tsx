// @vitest-environment jsdom
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VENDO_TREE_FORMAT_V2, type ToolOutcome } from "@vendoai/core";
import { AppFrame, PinMount, TreeView } from "../../src/tree/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).__vendoHostExecuted;
});

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

describe("AppFrame", () => {
  it("grants same-origin privilege only to a cross-origin machine url", () => {
    // A genuine machine url is the sandbox provider's — cross-origin to the host
    // — so it gets allow-same-origin (its own origin, never the host's).
    render(<AppFrame surface={{ kind: "http", url: "https://machine.invalid/app" }} />);
    const cross = screen.getByTitle("Vendo app") as HTMLIFrameElement;
    const crossTokens = cross.getAttribute("sandbox")!.split(" ");
    expect(crossTokens).toEqual(expect.arrayContaining(["allow-scripts", "allow-forms", "allow-same-origin"]));
  });

  it("withholds same-origin privilege from a same-origin machine url (one-security-rule)", () => {
    // A same-origin url + allow-same-origin would run the app in the HOST origin
    // with host storage/cookie/API access; it must run opaque instead.
    render(<AppFrame surface={{ kind: "http", url: `${window.location.origin}/evil` }} />);
    const same = screen.getByTitle("Vendo app") as HTMLIFrameElement;
    expect(same.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(same.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });

  it("pings on user activity, throttled to the keepalive interval (Wave 7 H2)", async () => {
    vi.useFakeTimers();
    try {
      const ping = vi.fn(async () => ({ state: "awake" as const }));
      const reopen = vi.fn(async () => undefined);
      render(
        <AppFrame
          surface={{ kind: "http", url: "https://machine.invalid/app" }}
          keepalive={{ ping, reopen, intervalMs: 1_000 }}
        />,
      );
      // Idle: ticks pass with no activity → no ping (nothing keeps an unused
      // machine awake).
      await vi.advanceTimersByTimeAsync(3_000);
      expect(ping).not.toHaveBeenCalled();
      // Host-page activity → one ping on the next tick, then throttled.
      fireEvent.pointerDown(window);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ping).toHaveBeenCalledTimes(1);
      expect(reopen).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a woke ping shows the resuming cover and re-opens the surface once (Wave 7 H2)", async () => {
    vi.useFakeTimers();
    try {
      const ping = vi.fn(async () => ({ state: "woke" as const }));
      let resolveReopen = () => undefined as void;
      const reopen = vi.fn(() => new Promise<void>((resolve) => { resolveReopen = () => resolve(); }));
      const { rerender } = render(
        <AppFrame
          surface={{ kind: "http", url: "https://machine.invalid/app" }}
          keepalive={{ ping, reopen, intervalMs: 1_000 }}
        />,
      );
      fireEvent.pointerDown(window);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(reopen).toHaveBeenCalledTimes(1);
      // While the re-open is in flight, the EXISTING wake/loading state
      // replaces the stale iframe — no dead embed under the user.
      expect(screen.getByLabelText("Vendo app resuming")).toBeTruthy();
      expect(screen.queryByTitle("Vendo app")).toBeNull();
      // The re-open lands a fresh surface URL; the frame comes back on it.
      await act(async () => {
        resolveReopen();
        await vi.advanceTimersByTimeAsync(0);
      });
      rerender(
        <AppFrame
          surface={{ kind: "http", url: "https://machine.invalid/app2" }}
          keepalive={{ ping, reopen, intervalMs: 1_000 }}
        />,
      );
      const frame = screen.getByTitle("Vendo app") as HTMLIFrameElement;
      expect(frame.src).toBe("https://machine.invalid/app2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a dimmed non-interactive resuming cover", () => {
    render(<AppFrame surface={{ kind: "resuming", cover: "data:image/png;base64,AA==" }} />);
    const frame = screen.getByLabelText("Vendo app resuming");
    expect(frame.getAttribute("aria-busy")).toBe("true");
    expect(frame.style.pointerEvents).toBe("none");
    expect(screen.getByRole("img", { name: "App loading cover" }).getAttribute("src"))
      .toBe("data:image/png;base64,AA==");
  });

  it("uses a skeleton when the resuming cover is absent", () => {
    render(<AppFrame surface={{ kind: "resuming" }} />);
    expect(document.querySelector('[data-primitive="Skeleton"]')).not.toBeNull();
  });

  it("dispatches tree surfaces through PayloadView", () => {
    render(
      <AppFrame
        surface={{
          kind: "tree",
          payload: {
            formatVersion: VENDO_TREE_FORMAT_V2,
            root: "root",
            nodes: [{ id: "root", component: "Text", props: { text: "Instant app" } }],
          },
        }}
        onAction={ok}
      />,
    );
    expect(screen.getByText("Instant app")).toBeTruthy();
  });

  it("contains unknown surface kinds", () => {
    render(<AppFrame surface={{ kind: "spatial" } as never} />);
    expect(screen.getByRole("note", { name: /unsupported app surface/i }).textContent).toContain("spatial");
  });
});

describe("PinMount", () => {
  it("falls back to the original host component when pinned content throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Original: ComponentType = () => <p>Original host content</p>;
    const BrokenPin = () => {
      throw new Error("pin failed");
    };

    render(
      <PinMount slot="invoice-card" fallback={Original}>
        <BrokenPin />
      </PinMount>,
    );
    expect(screen.getByText("Original host content")).toBeTruthy();
  });
});

describe("generated component jail structure", () => {
  it("relays captured modules, styles, and sample props as data without putting CSS in the outer frame", () => {
    const generatedTree = {
      formatVersion: VENDO_TREE_FORMAT_V2,
      root: "root",
      nodes: [{ id: "root", component: "Furnished", source: "generated" }],
      components: {
        Furnished: 'import { Badge } from "./Badge"; export default function Furnished({ title }) { return <Badge>{title}</Badge>; }',
      },
      furnishings: {
        Furnished: {
          sourceImports: { "./Badge": "src/Badge.tsx" },
          subSources: {
            "src/Badge.tsx": { source: "export function Badge({ children }) { return <strong>{children}</strong>; }", imports: {} },
          },
          sampleProps: { title: "Stubbed preview" },
          styles: [{ path: "src/app/globals.css", css: ".furnished-secret { color: rebeccapurple; }" }],
        },
      },
    } as UIPayload & { furnishings: Record<string, unknown> };

    render(<TreeView tree={generatedTree} components={{}} onAction={ok} />);
    const iframe = screen.getByTitle("Generated component: Furnished") as HTMLIFrameElement;
    expect(iframe.srcdoc).not.toContain(".furnished-secret");
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { kind: "booted" },
    }));

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: "render",
      props: { title: "Stubbed preview" },
      sourceImports: { "./Badge": "src/Badge.tsx" },
      styles: [{ path: "src/app/globals.css", css: ".furnished-secret { color: rebeccapurple; }" }],
    }), "*");
  });

  it("uses an opaque-origin iframe with CSP and never evaluates source in the host", () => {
    const evalSpy = vi.spyOn(globalThis, "eval");
    const source = [
      "globalThis.__vendoHostExecuted = true;",
      "export default function Unsafe() { return <p>inside only</p> }",
    ].join("\n");
    const generatedTree: UIPayload = {
      formatVersion: VENDO_TREE_FORMAT_V2,
      root: "root",
      nodes: [{ id: "root", component: "Unsafe", source: "generated" }],
      components: { Unsafe: source },
    };

    render(<TreeView tree={generatedTree} components={{}} onAction={ok} />);

    const iframe = screen.getByTitle("Generated component: Unsafe") as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.srcdoc).toContain('http-equiv="Content-Security-Policy"');
    expect(iframe.srcdoc).toContain("default-src 'none'");
    expect(iframe.srcdoc).toContain("connect-src 'none'");
    expect((globalThis as Record<string, unknown>).__vendoHostExecuted).toBeUndefined();
    expect(document.querySelector("script")).toBeNull();
    expect(evalSpy).not.toHaveBeenCalled();
  });

  it("recovers from a reported error when generated source changes", async () => {
    const broken: UIPayload = {
      formatVersion: VENDO_TREE_FORMAT_V2,
      root: "root",
      nodes: [{ id: "root", component: "Editable", source: "generated" }],
      components: { Editable: "export default function Editable() { throw new Error('broken') }" },
    };
    const fixed: UIPayload = {
      ...broken,
      components: { Editable: "export default function Editable() { return <p>fixed</p> }" },
    };
    const view = render(<TreeView tree={broken} components={{}} onAction={ok} />);
    const iframe = screen.getByTitle("Generated component: Editable") as HTMLIFrameElement;

    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { kind: "error", message: "broken" },
    }));
    expect(await screen.findByRole("note", { name: "Generated component error" })).toBeTruthy();

    view.rerender(<TreeView tree={fixed} components={{}} onAction={ok} />);
    await waitFor(() => expect(screen.getByTitle("Generated component: Editable")).toBeTruthy());
    expect(screen.queryByRole("note", { name: "Generated component error" })).toBeNull();
  });

  it("applies reported content height for both growth and shrinkage", () => {
    const generatedTree: UIPayload = {
      formatVersion: VENDO_TREE_FORMAT_V2,
      root: "root",
      nodes: [{ id: "root", component: "Resizable", source: "generated" }],
      components: { Resizable: "export default function Resizable() { return <p>content</p> }" },
    };

    render(<TreeView tree={generatedTree} components={{}} onAction={ok} />);
    const iframe = screen.getByTitle("Generated component: Resizable") as HTMLIFrameElement;

    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { kind: "resize", height: 1_400 },
    }));
    expect(iframe.style.height).toBe("1400px");

    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { kind: "resize", height: 280 },
    }));
    expect(iframe.style.height).toBe("280px");

    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { kind: "resize", height: 10_000 },
    }));
    expect(iframe.style.height).toBe("8192px");
  });

  it("contains a generated component that renders no content", async () => {
    const generatedTree: UIPayload = {
      formatVersion: VENDO_TREE_FORMAT_V2,
      root: "root",
      nodes: [{ id: "root", component: "Empty", source: "generated" }],
      components: { Empty: "export default function Empty() { return null; }" },
    };

    render(<TreeView tree={generatedTree} components={{}} onAction={ok} />);
    const iframe = screen.getByTitle("Generated component: Empty") as HTMLIFrameElement;

    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { kind: "empty" },
    }));

    expect((await screen.findByRole("note", { name: "Generated component error" })).textContent)
      .toBe("Empty: generated component rendered no content");
    expect(screen.queryByTitle("Generated component: Empty")).toBeNull();
  });
});
