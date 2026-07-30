/**
 * demo-funnel regression: the /vendo full page's FIRST-ever load must show the
 * five Maple scenario cards — not the fire-once greeting-as-tutorial (generic
 * "Getting started" chips). The overlay's MapleThread already passes
 * discoverability="quiet" for exactly this reason (VendoLayer.tsx); the full
 * page is the same scripted-demo landing and must match.
 *
 * demo-hygiene (criterion 24): the pre-generated "try this" chips ride the
 * suggestions as strings — N manifest entries ⇒ N chips after the cards; an
 * empty manifest keeps the ORIGINAL mapleScenarios array (no chip row, no
 * extra render), preserving the first-visit contract above.
 */
// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapleScenarios } from "@/vendo/scenarios";

const threadProps = vi.fn();

// The page now mounts the full workspace (VendoPage) and hands the thread
// contract through its `thread` prop — the invariants under test are the
// same, read at the new seam.
vi.mock("@vendoai/ui/chrome", () => ({
  VendoPage: ({ thread }: { thread: Record<string, unknown> }) => {
    threadProps(thread);
    return null;
  },
}));
vi.mock("@/components/vendo/VendoRoot", () => ({
  VendoRoot: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import VendoTabPage from "./page";

afterEach(() => {
  vi.unstubAllGlobals();
  threadProps.mockClear();
});

describe("/vendo full page thread", () => {
  it("shows the scenario cards on the very first visit: tutorial stands down, cards ride in", () => {
    render(<VendoTabPage />);
    expect(threadProps).toHaveBeenCalledTimes(1);
    const props = threadProps.mock.calls[0]?.[0] as Record<string, unknown>;
    // The fire-once greeting-as-tutorial would replace the suggestions on the
    // first-ever open (burning the flag) — quiet keeps the landing the cards.
    expect(props.discoverability).toBe("quiet");
    expect(props.suggestions).toBe(mapleScenarios);
  });

  it("an empty chip manifest keeps the single render and the original suggestions reference", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { chips: [] } }),
    })));
    render(<VendoTabPage />);
    // The chips fetch resolving empty must not re-render or copy the array.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(threadProps).toHaveBeenCalledTimes(1);
    expect(threadProps.mock.calls[0]?.[0].suggestions).toBe(mapleScenarios);
  });

  it("renders one chip per manifest entry below the cards", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { chips: [
        { key: "subs", prompt: "Build me a subscriptions tracker" },
        { key: "dining", prompt: "Where did my dining budget go?" },
      ] } }),
    })));
    render(<VendoTabPage />);
    await waitFor(() => {
      const last = threadProps.mock.lastCall?.[0] as { suggestions: unknown[] };
      expect(last.suggestions).toEqual([
        ...mapleScenarios,
        "Build me a subscriptions tracker",
        "Where did my dining budget go?",
      ]);
    });
  });
});
