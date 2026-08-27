// @vitest-environment jsdom
/**
 * Per-surface `theme` overrides on the chrome surfaces.
 *
 * One provider theme is the product's brand; a single surface sometimes has to
 * differ (a dark rail on a light page, a compact embed inside a dense console).
 * Every case here reads the CSS VARIABLES that actually land on the rendered
 * boundary — never a prop echo — so the merge, the portal threading, and the
 * frame-only limit are pinned against the real DOM.
 */
import type { ApprovalId, Json, ToolOutcome, UIPayload } from "@vendoai/core";
import type { VendoTheme } from "@vendoai/apps/contract";
import type { UIMessage } from "ai";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, defaultVendoTheme, type VendoClient } from "../../src/index.js";
import {
  ApprovalSheet,
  ChromeRoot,
  VendoAppEmbed,
  VendoApprovalEmbed,
  VendoOverlay,
  VendoSlot,
  VendoToasts,
  VendoToolResult,
  VendoTrigger,
  vendoToast,
} from "../../src/chrome/index.js";
import { TurnCitations } from "../../src/chrome/thread/turn-citations.js";
import { createWireServer } from "../wire-server.js";

let wire: Awaited<ReturnType<typeof createWireServer>>;
let client: VendoClient;

beforeEach(async () => {
  window.localStorage.clear();
  wire = await createWireServer();
  client = createVendoClient({ baseUrl: wire.url });
});

afterEach(async () => {
  // Unmount BEFORE closing the wire: a still-mounted surface keeps polling into
  // the closing server and server.close() livelocks to the hook timeout.
  cleanup();
  await wire.close();
});

/** The host brand, set once on the provider. */
const PROVIDER_THEME: Partial<VendoTheme> = {
  colors: {
    background: "#FBFBFA",
    surface: "#FFFFFF",
    text: "#111111",
    muted: "#908C85",
    accent: "#0f5132",
    accentText: "#FFFFFF",
    danger: "#B42318",
    border: "#ecebe8",
  },
  radius: { small: "6px", medium: "14px", large: "22px" },
  density: "comfortable",
};

/** One surface differing from it: a dark panel, tighter. Radius is deliberately
 *  ABSENT so the merge has something of the provider's to preserve. */
const SURFACE_THEME: Partial<VendoTheme> = {
  colors: {
    background: "#14151a",
    surface: "#1d1f27",
    text: "#f4f4f6",
    muted: "#9a9aa6",
    accent: "#8b5cf6",
    accentText: "#0b0b0f",
    danger: "#f97066",
    border: "#2c2e38",
  },
  density: "compact",
};

/** Read a custom property off the element's own inline style — what the
 *  cascade below it actually resolves against. */
const cssVar = (el: Element, name: string): string =>
  (el as HTMLElement).style.getPropertyValue(name);

/** The nearest chrome boundary in the rendered container. */
function boundary(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>(".vendo-root");
  expect(root, "expected a .vendo-root chrome boundary").not.toBeNull();
  return root!;
}

/** Every assertion the merge owes: the surface's groups win, the provider's
 *  untouched groups survive, and nothing silently falls back to the defaults. */
function expectMerged(el: Element): void {
  expect(cssVar(el, "--vendo-color-accent")).toBe("#8b5cf6");
  expect(cssVar(el, "--vendo-color-background")).toBe("#14151a");
  expect(cssVar(el, "--vendo-density")).toBe("compact");
  // The group the surface never mentioned is still the PROVIDER's, not the
  // default — this is a merge over the provider, not a replacement of it.
  expect(cssVar(el, "--vendo-radius-medium")).toBe("14px");
  expect(cssVar(el, "--vendo-radius-medium")).not.toBe(defaultVendoTheme.radius.medium);
}

function expectProvider(el: Element): void {
  expect(cssVar(el, "--vendo-color-accent")).toBe("#0f5132");
  expect(cssVar(el, "--vendo-density")).toBe("comfortable");
  expect(cssVar(el, "--vendo-radius-medium")).toBe("14px");
}

const withProvider = (children: React.ReactNode) => render(
  <VendoProvider client={client} theme={PROVIDER_THEME}>{children}</VendoProvider>,
);

describe("the surface theme merges over the provider's", () => {
  it("lands the merged tokens on the surface's own chrome boundary", async () => {
    const { container } = withProvider(<VendoSlot id="hero" theme={SURFACE_THEME} />);
    await screen.findByText("This space builds itself");
    expectMerged(boundary(container));
  });

  it("leaves a surface with no theme of its own on the provider's", async () => {
    const { container } = withProvider(<VendoSlot id="hero" />);
    await screen.findByText("This space builds itself");
    expectProvider(boundary(container));
  });

  /** The honest limit of the prop on a slot: a slot whose HOST markup is
   *  showing renders it untouched, with no wrapper at all (hosts inline slots
   *  anywhere, so it may not introduce a div). There is no Vendo chrome on
   *  screen, so there is nothing for a theme to style. */
  it("adds no boundary — and so no tokens — to a slot showing the host's own markup", async () => {
    const { container } = withProvider(<VendoSlot id="hero" theme={SURFACE_THEME}><span>Host hero</span></VendoSlot>);
    await screen.findByText("Host hero");
    expect(container.querySelector(".vendo-root")).toBeNull();
  });

  it("merges over the DEFAULTS when there is no provider at all", () => {
    const { container } = render(<VendoTrigger prompt="Pay this" theme={{ density: "compact" }} />);
    const root = boundary(container);
    expect(cssVar(root, "--vendo-density")).toBe("compact");
    // Everything unsaid is the default brand, not blank.
    expect(cssVar(root, "--vendo-color-accent")).toBe(defaultVendoTheme.colors.accent);
  });

  it("stamps the merged density and motion attributes the sheet keys off", async () => {
    const { container } = withProvider(
      <VendoSlot id="hero" theme={{ ...SURFACE_THEME, motion: "reduced" }} />,
    );
    await screen.findByText("This space builds itself");
    const root = boundary(container);
    expect(root.dataset.vendoDensity).toBe("compact");
    expect(root.dataset.vendoMotion).toBe("reduced");
  });
});

describe("every chrome surface takes one", () => {
  it("VendoSlot", async () => {
    const { container } = withProvider(<VendoSlot id="hero" theme={SURFACE_THEME} />);
    await screen.findByText("This space builds itself");
    expectMerged(boundary(container));
  });

  it("VendoTrigger", () => {
    const { container } = withProvider(<VendoTrigger prompt="Pay this" theme={SURFACE_THEME} />);
    expectMerged(boundary(container));
  });

  it("VendoOverlay — the launcher boundary AND the panel it portals to <body>", async () => {
    const { container } = withProvider(<VendoOverlay defaultOpen theme={SURFACE_THEME} />);
    expectMerged(boundary(container));
    // The panel escapes the host stacking context entirely, so it hand-rolls
    // its own boundary. The two halves of one surface must not disagree.
    const panel = await waitFor(() => {
      const found = document.querySelector(".fl-overlay-portal");
      expect(found).not.toBeNull();
      return found!;
    });
    expectMerged(panel);
  });

  it("VendoAppEmbed", async () => {
    const { container } = withProvider(
      <VendoAppEmbed refValue={{ kind: "vendo/app-ref@1", appId: "app_x", title: "Dashboard", status: "building" }} theme={SURFACE_THEME} />,
    );
    await screen.findByText("Dashboard");
    expectMerged(boundary(container));
  });

  it("VendoApprovalEmbed", async () => {
    const { container } = withProvider(
      <VendoApprovalEmbed refValue={{ kind: "vendo/approval-ref@1", approvalId: "apr_x", summary: "Send the report" }} theme={SURFACE_THEME} />,
    );
    await screen.findByText("Send the report");
    expectMerged(boundary(container));
  });

  it("VendoToolResult — through the embed it dispatches to", async () => {
    const { container } = withProvider(
      <VendoToolResult output={{ kind: "vendo/app-ref@1", appId: "app_y", title: "Spending", status: "building" }} theme={SURFACE_THEME} />,
    );
    await screen.findByText("Spending");
    expectMerged(boundary(container));
  });

  it("VendoToolResult — on the automation branch too, not just the embeds", async () => {
    const { container } = withProvider(
      <VendoToolResult output={{ kind: "vendo/automation-ref@1", automationId: "aut_1", summary: "Every Monday, email the report", armed: true }} theme={SURFACE_THEME} />,
    );
    await screen.findByText("Every Monday, email the report");
    expectMerged(boundary(container));
  });
});

/** One assistant turn carrying a knowledge citation, so the hovercard has a
 *  real chip to open from. */
function citationsTurn(): UIMessage {
  return {
    id: "msg_knowledge",
    role: "assistant",
    parts: [
      {
        type: "data-vendo-citations",
        data: {
          toolCallId: "call_search",
          outcome: "answered",
          citations: [{
            docId: "doc-refunds",
            chunkId: "doc-refunds#0",
            title: "Refunds & cancellations",
            source: "docs/refunds.md",
            kind: "docs",
            visibility: "public",
            snippet: "If you cancel mid-cycle we do not charge again.",
          }],
        },
      } as UIMessage["parts"][number],
    ],
  };
}

/** A pinned generated view that parks its press on the guard — the real path
 *  from a press inside a slot to the approval modal on <body>. */
const PARKING_PIN = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [{ id: "root", component: "Button", props: { label: "Pay the bill", onClick: { $action: "host_pay" } } }],
} as UIPayload;

const parkOnPress = async (): Promise<ToolOutcome> =>
  ({ status: "pending-approval", approvalId: "apr_1" as ApprovalId }) as ToolOutcome;

describe("surfaces that portal out of the boundary still wear its theme", () => {
  it("the approval modal a themed slot's press parks carries the SLOT's theme", async () => {
    withProvider(
      <VendoSlot
        id="hero"
        theme={SURFACE_THEME}
        pin={{ payload: PARKING_PIN, onAction: parkOnPress as (req: { nodeId: string; action: string; payload?: Json }) => Promise<ToolOutcome> }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Pay the bill" }));
    // The modal portals to <body>, so no DOM cascade reaches it — only the
    // React context the slot's boundary publishes.
    const layer = await waitFor(() => {
      const found = document.querySelector(".fl-apmodal-layer");
      expect(found).not.toBeNull();
      return found!;
    });
    expectMerged(layer);
  });

  it("the same modal falls back to the provider theme when the slot set none", async () => {
    withProvider(
      <VendoSlot
        id="hero"
        pin={{ payload: PARKING_PIN, onAction: parkOnPress as (req: { nodeId: string; action: string; payload?: Json }) => Promise<ToolOutcome> }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Pay the bill" }));
    const layer = await waitFor(() => {
      const found = document.querySelector(".fl-apmodal-layer");
      expect(found).not.toBeNull();
      return found!;
    });
    expectProvider(layer);
  });

  /** `VendoToasts` is normally mounted bare at the app root, so its usual
   *  answer is the provider theme. Inside a themed chrome boundary it takes
   *  that boundary's — the same context read the approval modal makes.
   *  `ChromeRoot` IS that boundary (it is what every surface's `theme` prop
   *  feeds), so this composes the real seam rather than stubbing one. */
  it("the toast stack wears the enclosing surface's theme, and the provider's when mounted bare", async () => {
    withProvider(
      <ChromeRoot theme={SURFACE_THEME}>
        <VendoToasts />
      </ChromeRoot>,
    );
    vendoToast({ text: "Report ready" });
    const inside = await waitFor(() => {
      const found = document.querySelector("[data-vendo-portal=\"toasts\"]");
      expect(found).not.toBeNull();
      return found!;
    });
    // A real toast is on screen — not an empty stack that would carry tokens
    // without ever showing them to anyone.
    expect(inside.textContent).toContain("Report ready");
    expectMerged(inside);
    cleanup();

    withProvider(<VendoToasts />);
    vendoToast({ text: "Report ready" });
    const bare = await waitFor(() => {
      const found = document.querySelector("[data-vendo-portal=\"toasts\"]");
      expect(found).not.toBeNull();
      return found!;
    });
    expectProvider(bare);
  });

  /** The knowledge citation hovercard portals to <body> out of the thread that
   *  themes it. A dark overlay must not pop a light provider-themed card. */
  it("the citation hovercard carries the enclosing surface's theme", () => {
    withProvider(
      <ChromeRoot theme={SURFACE_THEME}>
        <TurnCitations message={citationsTurn()} />
      </ChromeRoot>,
    );
    fireEvent.pointerEnter(document.querySelector<HTMLElement>(".fl-cite")!);
    const card = document.querySelector("[data-vendo-portal=\"citation\"]");
    expect(card, "expected the portaled citation card").not.toBeNull();
    expectMerged(card!);
  });

  it("the citation hovercard falls back to the provider theme with no surface theme", () => {
    withProvider(
      <ChromeRoot>
        <TurnCitations message={citationsTurn()} />
      </ChromeRoot>,
    );
    fireEvent.pointerEnter(document.querySelector<HTMLElement>(".fl-cite")!);
    expectProvider(document.querySelector("[data-vendo-portal=\"citation\"]")!);
  });

  /** The mobile presentation of a consent — same portal, same rule. */
  it("the mobile approval sheet carries the enclosing surface's theme", () => {
    withProvider(
      <ChromeRoot theme={SURFACE_THEME}>
        <ApprovalSheet label="Approval for Send the report"><p>Send the report?</p></ApprovalSheet>
      </ChromeRoot>,
    );
    const layer = document.querySelector(".fl-approval-sheet-layer");
    expect(layer, "expected the portaled approval sheet").not.toBeNull();
    expectMerged(layer!);
  });

  it("the mobile approval sheet falls back to the provider theme with no surface theme", () => {
    withProvider(
      <ChromeRoot>
        <ApprovalSheet label="Approval for Send the report"><p>Send the report?</p></ApprovalSheet>
      </ChromeRoot>,
    );
    expectProvider(document.querySelector(".fl-approval-sheet-layer")!);
  });
});

describe("FRAME ONLY — a generated view keeps the provider theme", () => {
  /**
   * The honest answer to "does a natively rendered pin inherit the slot's local
   * tokens by cascade?" It does NOT. The tree surface is its own theme boundary
   * (renderer.tsx's TreeView) and restates the PROVIDER tokens on
   * `[data-vendo-surface]`, which shadows the slot's boundary for everything
   * inside it. So a pin and an iframe-served app agree: the frame is local, the
   * view is the provider's — the same theme that ships over `?vendoTheme=`.
   *
   * This is the behavior, not an accident of ordering: the assertion below is
   * what would go red if a future change let the local tokens leak into a
   * generated view.
   */
  it("a pin rendered natively in a themed slot paints in the PROVIDER theme", async () => {
    const { container } = withProvider(
      <VendoSlot id="hero" theme={SURFACE_THEME} pin={{ payload: {
        formatVersion: "vendo-genui/v2",
        root: "root",
        nodes: [{ id: "root", component: "Text", props: { text: "Pinned revenue card" } }],
      } as UIPayload }} />,
    );
    await screen.findByText("Pinned revenue card");

    // The frame around it took the local theme…
    expectMerged(boundary(container));

    // …and the generated view inside it did not.
    const surface = container.querySelector("[data-vendo-surface]");
    expect(surface, "expected the tree surface's own theme boundary").not.toBeNull();
    expect(cssVar(surface!, "--vendo-color-accent")).toBe("#0f5132");
    expect(cssVar(surface!, "--vendo-color-background")).toBe("#FBFBFA");
    expect(cssVar(surface!, "--vendo-density")).toBe("comfortable");
  });
});
