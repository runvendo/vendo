/**
 * demo-funnel regression: the /vendo full page's FIRST-ever load must show the
 * Maple scenario cards — not the fire-once greeting-as-tutorial (a generic
 * "Getting started" suggestion row). The overlay's MapleThread already passes
 * discoverability="quiet" for exactly this reason (VendoLayer.tsx); the full
 * page is the same scripted-demo landing and must match.
 */
// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
});
