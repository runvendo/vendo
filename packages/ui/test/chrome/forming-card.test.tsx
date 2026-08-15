// @vitest-environment jsdom
/**
 * The build's FIRST seconds, and the flight that follows.
 *
 * THE DEFECT this exists for: `vendo_make` goes on the wire the moment a build
 * starts, but its beat is suppressed (narratedByAppCard) in favour of an app
 * card that only mounts on the first `data-vendo-view` part — so between the
 * ask and the first view bytes the transcript said nothing build-specific at
 * all, for as long as generation took.
 */
import { cleanup, render } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";
import { ThreadPart } from "../../src/chrome/thread/parts.js";
import { VendoProvider } from "../../src/index.js";

afterEach(cleanup);

function makeCall(state: "input-available" | "output-available"): UIMessage["parts"][number] {
  return {
    type: "dynamic-tool",
    toolName: "vendo_make",
    toolCallId: "call_make",
    state,
    input: { request: "a spending breakdown" },
    ...(state === "output-available" ? { output: { made: true } } : {}),
  } as unknown as UIMessage["parts"][number];
}

const VIEW_PART = {
  type: "data-vendo-view",
  data: {
    appId: "app_spending",
    payload: {
      formatVersion: "vendo-genui/v2",
      name: "Spending",
      root: "root",
      nodes: [{ id: "root", component: "Stack" }],
      streaming: true,
    },
  },
} as unknown as UIMessage["parts"][number];

function renderCall(part: UIMessage["parts"][number], siblingParts: UIMessage["parts"], turnPending = true) {
  return render(
    <VendoProvider>
      <ThreadPart
        part={part}
        partKey="p0"
        role="assistant"
        restored={false}
        risks={new Map()}
        turnPending={turnPending}
        siblingParts={siblingParts}
      />
    </VendoProvider>,
  );
}

describe("the pre-view build window", () => {
  it("mounts the empty app card as soon as the build call is on the wire", () => {
    const call = makeCall("input-available");
    renderCall(call, [call]);
    const bar = document.querySelector(".fl-appcard-bar");
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute("data-state")).toBe("building");
    expect(bar!.textContent).toContain("Building your view");
    // Build calm (spec §8) — the sweeping hairline is the one moving thing.
    expect(bar!.querySelector(".fl-boot-hairline")).not.toBeNull();
    expect(document.querySelector("[data-skeleton]")).not.toBeNull();
  });

  it("stands down the moment the first view part lands, so there is one card", () => {
    const call = makeCall("input-available");
    renderCall(call, [call, VIEW_PART]);
    expect(document.querySelector("[data-vendo-app-forming]")).toBeNull();
    expect(document.querySelector(".fl-appcard-bar")).toBeNull();
  });

  it("never sweeps on a turn that is over", () => {
    const call = makeCall("input-available");
    renderCall(call, [call], false);
    expect(document.querySelector("[data-vendo-app-forming]")).toBeNull();
  });

  it("leaves a settled build call to its own card", () => {
    const call = makeCall("output-available");
    renderCall(call, [call, VIEW_PART]);
    expect(document.querySelector("[data-vendo-app-forming]")).toBeNull();
  });
});

describe("the conversation under a flying view", () => {
  it("blurs the rail while the embed ghost crosses it, and clears when it lands", () => {
    expect(CHROME_CSS).toContain(".fl-overlay-panel[data-vendo-ghost] .fl-split-rail { filter: blur(7px); }");
    expect(CHROME_CSS).toContain("filter .22s ease");
  });

  it("keeps the conversation sharp under reduced motion — a blur that cannot fade is a flash", () => {
    const reduced = CHROME_CSS.slice(CHROME_CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".fl-overlay-panel[data-vendo-ghost] .fl-split-rail { filter: none; }");
  });
});
