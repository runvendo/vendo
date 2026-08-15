// @vitest-environment jsdom
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type ToolOutcome } from "@vendoai/core";
import { AppFrame, PinMount } from "../../src/tree/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).__vendoHostExecuted;
});

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

/** Only the server's hash-pin verdict unlocks the in-client mount. */
const GRANTED = {
  granted: true as const,
  versionHash: "sha256:approved",
  approvedBy: "host-console",
  at: "2026-07-15T09:00:00.000Z",
};

/** An approved component that writes one `$state` key through the vendo bridge. */
const setStateSource = (name: string, value: string) => `
import { useEffect } from "react";
export default function ${name}({ vendo }) {
  useEffect(() => { vendo.setState("draft", ${JSON.stringify(value)}); }, []);
  return <div>editor</div>;
}`;

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

  it("fits the served app's reported height, inside the host's bounds", () => {
    // ONE resize protocol: the served app reports the same `{vendo, kind, height}`
    // every embedded surface does, and the http frame honours it through the same
    // shared gate/clamp (tree/frame-resize.ts).
    render(<AppFrame surface={{ kind: "http", url: "https://machine.invalid/app" }} />);
    const frame = screen.getByTitle("Vendo app") as HTMLIFrameElement;

    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      data: { vendo: true, kind: "resize", height: 640 },
    }));
    expect(frame.style.height).toBe("640px");

    // The host's slot is a constraint the app lives inside, never overrides.
    frame.style.maxHeight = "420px";
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      data: { vendo: true, kind: "resize", height: 3_000 },
    }));
    expect(frame.style.height).toBe("420px");
  });

  it("ignores a resize from any window other than the app's own frame", () => {
    render(<AppFrame surface={{ kind: "http", url: "https://machine.invalid/app" }} />);
    const frame = screen.getByTitle("Vendo app") as HTMLIFrameElement;

    window.dispatchEvent(new MessageEvent("message", {
      source: window,
      data: { vendo: true, kind: "resize", height: 2_000 },
    }));
    expect(frame.style.height).toBe("");
  });

  it("pings on user activity, throttled to the keepalive interval (Wave 7 H2)", async () => {
    vi.useFakeTimers();
    try {
      const ping = vi.fn(async () => ({ state: "awake" as const }));
      render(
        <AppFrame
          surface={{ kind: "http", url: "https://machine.invalid/app" }}
          keepalive={{ ping, intervalMs: 1_000 }}
        />,
      );
      // Idle: ticks pass with no activity → no ping. NOTHING KEEPS AN UNUSED
      // MACHINE AWAKE — a sandbox machine is paid for by the second, so an
      // embed nobody is using must be allowed to sleep. A tab left open is not
      // use.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(ping).not.toHaveBeenCalled();
      // Host-page activity → one ping on the next tick, then throttled.
      fireEvent.pointerDown(window);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ping).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts focus inside the cross-origin frame as activity (Wave 7 H2)", async () => {
    vi.useFakeTimers();
    try {
      // Activity INSIDE the frame is invisible to the host page, so the frame
      // holding focus is the only observable signal that someone is using it.
      const ping = vi.fn(async () => ({ state: "awake" as const }));
      render(
        <AppFrame
          surface={{ kind: "http", url: "https://machine.invalid/app" }}
          keepalive={{ ping, intervalMs: 1_000 }}
        />,
      );
      (screen.getByTitle("Vendo app") as HTMLIFrameElement).focus();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ping).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a woke ping is not the frame's problem: no cover, no re-open (URLs are stable)", async () => {
    vi.useFakeTimers();
    try {
      // The machine slept and woke. With a stable proxy URL the frame's address
      // never changed, so there is nothing to re-open and nothing to cover — the
      // live embed stays under the user.
      const ping = vi.fn(async () => ({ state: "woke" as const }));
      render(
        <AppFrame
          surface={{ kind: "http", url: "https://machine.invalid/app" }}
          keepalive={{ ping, intervalMs: 1_000 }}
        />,
      );
      fireEvent.pointerDown(window);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(ping).toHaveBeenCalledTimes(1);
      expect(screen.queryByLabelText("Vendo app resuming")).toBeNull();
      const frame = screen.getByTitle("Vendo app") as HTMLIFrameElement;
      expect(frame.src).toBe("https://machine.invalid/app");
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
    expect(document.querySelector('[data-skeleton]')).not.toBeNull();
  });

  it("dispatches tree surfaces through PayloadView", () => {
    render(
      <AppFrame
        surface={{
          kind: "tree",
          payload: {
            formatVersion: VENDO_TREE_FORMAT,
            root: "root",
            nodes: [{ id: "root", component: "Text", props: { text: "Instant app" } }],
          },
        }}
        onAction={ok}
      />,
    );
    expect(screen.getByText("Instant app")).toBeTruthy();
  });

  it("does not carry one app's $state into the next app mounted in its place", async () => {
    // The same leak as the TreeView case, through the surface a host actually
    // renders: both apps carry the compiler's synthetic `root`, so only `appId`
    // separates them.
    const StateProbe: ComponentType<{ value?: unknown }> = ({ value }) => <output>{String(value)}</output>;
    const payload = (component: string, value: string) => ({
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [
        { id: "root", component: "Row", children: ["generated", "probe"] },
        { id: "generated", component, source: "generated" as const },
        { id: "probe", component: "StateProbe", source: "host" as const, props: { value: { $state: "draft" } } },
      ],
      components: { [component]: setStateSource(component, value) },
      inClient: GRANTED,
    });

    const view = render(
      <AppFrame
        appId="app_a"
        surface={{ kind: "tree", payload: payload("EditorA", "belongs to app A") }}
        components={{ StateProbe }}
        onAction={ok}
      />,
    );
    await waitFor(() => expect(screen.getByText("belongs to app A")).toBeTruthy());

    view.rerender(
      <AppFrame
        appId="app_b"
        surface={{ kind: "tree", payload: payload("EditorB", "belongs to app B") }}
        components={{ StateProbe }}
        onAction={ok}
      />,
    );
    expect(screen.queryByText("belongs to app A")).toBeNull();
    await waitFor(() => expect(screen.getByText("belongs to app B")).toBeTruthy());
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
