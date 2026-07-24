import { describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import { demoBeatPlan, waitForTurn } from "./capture.js";

describe("demoBeatPlan", () => {
  it("sequences the config beats into one continuous overlay story", () => {
    expect(demoBeatPlan([
      { key: "generate-ui", prompt: "Show me a dashboard of my data", chip: "Dashboard", expectsView: true },
      { key: "take-action", prompt: "Archive the item named Bravo", chip: "Archive", expectsApproval: true },
      { key: "save-app", prompt: "Save this as a reusable app", chip: "Save" },
    ])).toEqual([
      {
        key: "generate-ui",
        prompt: "Show me a dashboard of my data",
        overlayBeat: "BEAT 1/3 · GENERATE UI",
        expectsView: true,
        expectsApproval: false,
      },
      {
        key: "take-action",
        prompt: "Archive the item named Bravo",
        overlayBeat: "BEAT 2/3 · TAKE ACTION",
        expectsView: false,
        expectsApproval: true,
      },
      {
        key: "save-app",
        prompt: "Save this as a reusable app",
        overlayBeat: "BEAT 3/3 · SAVE APP",
        expectsView: false,
        expectsApproval: false,
      },
    ]);
  });
});

/** The page state one poll tick observes. */
interface FakeTick {
  approveVisible?: boolean;
  approvalRequested?: boolean;
  composerEnabled?: boolean;
  busyIndicators?: boolean;
  assistantTurns?: number;
  errorText?: string;
}

/**
 * A scripted stand-in for the handful of Playwright calls waitForTurn makes.
 * Each waitForTimeout advances to the next tick (the last tick is sticky);
 * clicking Approve consumes the card for the current and later ticks.
 */
function fakePage(ticks: FakeTick[]) {
  let index = 0;
  const clicks: number[] = [];
  const current = (): FakeTick => ticks[Math.min(index, ticks.length - 1)]!;
  const approveVisible = () => current().approveVisible === true && clicks.length === 0;

  const zeroOrOne = (present: boolean, onClick?: () => void) => ({
    count: async () => (present ? 1 : 0),
    isVisible: async () => present,
    isEnabled: async () => present,
    textContent: async () => current().errorText ?? null,
    first() { return this; },
    click: async () => onClick?.(),
  });

  const page = {
    stepAtReturn: () => index,
    clicks,
    getByRole: (role: string, options?: { name?: string }) => {
      if (options?.name === "Approve") return zeroOrOne(approveVisible(), () => clicks.push(index));
      throw new Error(`Unexpected getByRole in fake: ${options?.name ?? role}`);
    },
    locator(selector: string, options?: { hasText?: string }) {
      if (selector.includes(".fl-error")) return zeroOrOne(current().errorText !== undefined);
      if (selector.includes("Message composer")) {
        return {
          getByRole: () => ({ isEnabled: async () => current().composerEnabled === true }),
        };
      }
      if (selector.includes("aria-busy")) return { count: async () => (current().busyIndicators ? 1 : 0) };
      if (selector === ".fl-tool-detail" && options?.hasText === "approval-requested") {
        return { count: async () => (current().approvalRequested ? 1 : 0) };
      }
      if (selector === '[aria-label="Demo unavailable"]') return zeroOrOne(false);
      if (selector === 'article[data-role="assistant"]') {
        return {
          count: async () => current().assistantTurns ?? 0,
          last: () => ({ locator: () => ({ count: async () => 1 }) }),
        };
      }
      throw new Error(`Unexpected locator in fake: ${selector}`);
    },
    evaluate: async () => null,
    waitForTimeout: async () => { index += 1; },
  };
  return page as unknown as Page & { stepAtReturn(): number; clicks: number[] };
}

describe("waitForTurn", () => {
  it("does not settle after an approval until the resumed run goes busy and returns idle", async () => {
    // Trap: right after the Approve click the composer is momentarily idle and
    // a new assistant article already exists — settling there would declare
    // the beat done while the approved tool is still executing.
    const page = fakePage([
      { approveVisible: true, composerEnabled: true, assistantTurns: 1 },
      { approvalRequested: true, composerEnabled: true, assistantTurns: 1 },
      { composerEnabled: true, assistantTurns: 1 }, // approval resolved, but the run never went busy yet
      { composerEnabled: false, busyIndicators: true, assistantTurns: 1 }, // resumed run busy
      { composerEnabled: true, assistantTurns: 2 }, // settled for real
    ]);
    const { approvals } = await waitForTurn({
      page,
      previousAssistantTurns: 0,
      timeoutMs: 5_000,
      requireView: false,
    });
    expect(approvals).toBe(1);
    expect(page.stepAtReturn()).toBeGreaterThanOrEqual(4);
  });

  it("settles on a new idle turn without approvals, as before", async () => {
    const page = fakePage([
      { composerEnabled: false, busyIndicators: true },
      { composerEnabled: true, assistantTurns: 1 },
    ]);
    const { approvals } = await waitForTurn({
      page,
      previousAssistantTurns: 0,
      timeoutMs: 5_000,
      requireView: false,
    });
    expect(approvals).toBe(0);
  });
});
