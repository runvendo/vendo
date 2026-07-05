import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";
import type { UINode } from "@vendoai/core";
import { VendoShellProvider, useShell, type ShellContextValue } from "../context";
import { createLocalRemixes, type RemixClient } from "../seams/remixes";
import { VendoRemix, REMIX_CHANGED_EVENT } from "./VendoRemix";

const validPayload = (data?: Record<string, unknown>) => ({
  formatVersion: "vendo-genui/v1",
  root: "n1",
  nodes: [{ id: "n1", component: "Text", props: { text: "remixed" } }],
  ...(data ? { data } : {}),
});

const pinnedNode = (payload: unknown): UINode => ({ id: "v1", kind: "generated", payload });

let shell: ShellContextValue;
function Probe() {
  shell = useShell();
  return null;
}

function mount(ui: ReactNode, opts: { remixes?: RemixClient } = {}) {
  return render(
    <VendoShellProvider
      store={undefined as never}
      {...(opts.remixes ? { remixes: opts.remixes } : {})}
      renderNode={(node) => (
        <div data-testid="pinned-view">
          {JSON.stringify(
            ((node as { payload?: { data?: { anchor?: unknown } } }).payload?.data ?? {}).anchor,
          )}
        </div>
      )}
    >
      <Probe />
      {ui}
    </VendoShellProvider>,
  );
}

describe("VendoRemix", () => {
  it("renders children untouched by default, with the affordance and no pill", async () => {
    mount(
      <VendoRemix id="w1" label="Widget">
        <div data-testid="host-widget">original</div>
      </VendoRemix>,
    );
    expect(screen.getByTestId("host-widget").textContent).toBe("original");
    const affordance = await screen.findByLabelText("Ask about Widget");
    expect(affordance.hasAttribute("data-affordance")).toBe(false);
    expect(document.querySelector(".fl-remix-pill")).toBeNull();
  });

  it("can keep the affordance visible for discoverability", async () => {
    mount(
      <VendoRemix id="w1" label="Widget" affordance="always">
        <div data-testid="host-widget">original</div>
      </VendoRemix>,
    );
    const affordance = await screen.findByLabelText("Ask about Widget");
    expect(affordance.getAttribute("data-affordance")).toBe("always");
  });

  it("keeps CSS rules for persistent and default hover affordances", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(
      /\.fl-remix-btn\[data-affordance="always"\]\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*scale\(1\);[^}]*\}/s,
    );
    expect(css).toMatch(
      /\.fl-remix:hover\s+\.fl-remix-btn,\s*\.fl-remix:focus-within\s+\.fl-remix-btn\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*scale\(1\);[^}]*\}/s,
    );
    expect(css).toMatch(
      /\.fl-remix-btn\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*scale\(\.9\);[^}]*\}/s,
    );
  });

  it("registers with the page registry on mount and deregisters on unmount", async () => {
    const { unmount } = mount(
      <VendoRemix id="w1" label="Widget" context={{ rows: 2 }}>
        <div>original</div>
      </VendoRemix>,
    );
    expect(shell.registry.ambient()).toEqual([
      { anchorId: "w1", label: "Widget", context: { rows: 2 } },
    ]);
    unmount();
    expect(shell.registry.ambient()).toEqual([]);
  });

  it("clicking the affordance scopes the overlay with a DOM baseline snapshot", async () => {
    mount(
      <VendoRemix id="w1" label="Widget" context={{ rows: 2 }}>
        <table>
          <tbody>
            <tr>
              <td>Acme</td>
            </tr>
          </tbody>
        </table>
      </VendoRemix>,
    );
    fireEvent.click(await screen.findByLabelText("Ask about Widget"));
    const scope = shell.scope.current();
    expect(scope?.anchorId).toBe("w1");
    expect(scope?.label).toBe("Widget");
    expect(scope?.context).toEqual({ rows: 2 });
    expect(scope?.snapshot).toContain("<td>Acme</td>");
  });

  it("scoped open of a pinned anchor carries the pin's sealed envelope (remix fast-edits)", async () => {
    const remixes = createLocalRemixes();
    await remixes.pin({
      anchorId: "w1",
      node: pinnedNode(validPayload()),
      envelope: "sealed-authored-state",
    });
    mount(
      <VendoRemix id="w1" label="Widget">
        <div>original</div>
      </VendoRemix>,
      { remixes },
    );
    // Wait for the pin to load (pill appears), then open the scoped overlay.
    await waitFor(() => expect(document.querySelector(".fl-remix-pill")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Ask about Widget"));
    expect(shell.scope.current()?.envelope).toBe("sealed-authored-state");
    // An unpinned anchor scopes WITHOUT an envelope.
    const bare = createLocalRemixes();
    mount(
      <VendoRemix id="w2" label="Bare">
        <div>original</div>
      </VendoRemix>,
      { remixes: bare },
    );
    fireEvent.click(await screen.findByLabelText("Ask about Bare"));
    expect(shell.scope.current()?.envelope).toBeUndefined();
  });

  it("renders a valid pin in place with live anchor data, and reset restores children", async () => {
    const remixes = createLocalRemixes();
    await remixes.pin({ anchorId: "w1", node: pinnedNode(validPayload()) });
    mount(
      <VendoRemix id="w1" label="Widget" context={{ rows: 5 }}>
        <div data-testid="host-widget">original</div>
      </VendoRemix>,
      { remixes },
    );
    // Pinned view replaces children, patched with the anchor context.
    await waitFor(() => expect(screen.getByTestId("pinned-view")).toBeTruthy());
    expect(screen.getByTestId("pinned-view").textContent).toBe('{"rows":5}');
    expect(screen.queryByTestId("host-widget")).toBeNull();
    expect(document.querySelector(".fl-remix-pill")?.textContent ?? "").toMatch(/customized/);

    fireEvent.click(screen.getByText("reset"));
    await waitFor(() => expect(screen.getByTestId("host-widget")).toBeTruthy());
    expect(screen.queryByTestId("pinned-view")).toBeNull();
    expect(await remixes.get("w1")).toBeNull();
  });

  it("fails open to original children when the pinned payload is invalid", async () => {
    const remixes = createLocalRemixes();
    await remixes.pin({ anchorId: "w1", node: pinnedNode({ not: "a payload" }) });
    mount(
      <VendoRemix id="w1">
        <div data-testid="host-widget">original</div>
      </VendoRemix>,
      { remixes },
    );
    await waitFor(() =>
      expect(document.querySelector(".fl-remix-pill")?.textContent ?? "").toMatch(/unavailable/),
    );
    expect(screen.getByTestId("host-widget")).toBeTruthy();
    expect(screen.queryByTestId("pinned-view")).toBeNull();
  });

  it("fails open on host-component drift", async () => {
    const remixes = createLocalRemixes();
    await remixes.pin({
      anchorId: "w1",
      node: pinnedNode(validPayload()),
      components: { GoneCard: "1" }, // stamped against a component no longer registered
    });
    mount(
      <VendoRemix id="w1">
        <div data-testid="host-widget">original</div>
      </VendoRemix>,
      { remixes },
    );
    await waitFor(() =>
      expect(document.querySelector(".fl-remix-pill")?.textContent ?? "").toMatch(/unavailable/),
    );
    expect(screen.getByTestId("host-widget")).toBeTruthy();
  });

  it("reloads its pin when the remix-changed event fires for its anchor (Apply flow)", async () => {
    const remixes = createLocalRemixes();
    mount(
      <VendoRemix id="w1" context={{ rows: 1 }}>
        <div data-testid="host-widget">original</div>
      </VendoRemix>,
      { remixes },
    );
    expect(screen.getByTestId("host-widget")).toBeTruthy();

    await act(async () => {
      await remixes.pin({ anchorId: "w1", node: pinnedNode(validPayload()) });
      window.dispatchEvent(
        new CustomEvent(REMIX_CHANGED_EVENT, { detail: { anchorId: "w1" } }),
      );
    });
    await waitFor(() => expect(screen.getByTestId("pinned-view")).toBeTruthy());
  });
});
