/**
 * demo-funnel regression: the /vendo full page's FIRST-ever load must show the
 * five Maple scenario cards — not the fire-once greeting-as-tutorial (generic
 * "Getting started" chips). The overlay's MapleThread already passes
 * discoverability="quiet" for exactly this reason (VendoLayer.tsx); the full
 * page is the same scripted-demo landing and must match.
 *
 * demo-hygiene (criterion 24): the pre-generated "try this" chips ride the
 * suggestions as strings — N manifest entries ⇒ N chips after the cards; an
 * empty manifest ⇒ the cards alone (no chip row).
 */
// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapleScenarios } from "@/vendo/scenarios";

const threadProps = vi.fn();

vi.mock("@vendoai/ui/chrome", () => ({
  VendoActivities: () => null,
  VendoThread: (props: Record<string, unknown>) => {
    threadProps(props);
    return null;
  },
}));
vi.mock("@vendoai/ui/voice", () => ({ VendoStage: () => null }));
vi.mock("@/components/vendo/VendoRoot", () => ({
  VendoRoot: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import VendoTabPage from "./page";

function stubChipsFetch(chips: { key: string; prompt: string }[]): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: { chips } }),
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  threadProps.mockClear();
});

describe("/vendo full page thread", () => {
  it("shows the scenario cards on the very first visit: tutorial stands down, cards ride in", async () => {
    stubChipsFetch([]);
    render(<VendoTabPage />);
    const props = threadProps.mock.calls[0]?.[0] as Record<string, unknown>;
    // The fire-once greeting-as-tutorial would replace the suggestions on the
    // first-ever open (burning the flag) — quiet keeps the landing the cards.
    expect(props.discoverability).toBe("quiet");
    expect(props.suggestions).toEqual(mapleScenarios);
    // An empty chip manifest never adds string suggestions — no chip row.
    await waitFor(() => {
      const last = threadProps.mock.lastCall?.[0] as { suggestions: unknown[] };
      expect(last.suggestions).toEqual(mapleScenarios);
    });
  });

  it("renders one chip per manifest entry below the cards; empty manifest adds none", async () => {
    stubChipsFetch([
      { key: "subs", prompt: "Build me a subscriptions tracker" },
      { key: "dining", prompt: "Where did my dining budget go?" },
    ]);
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
