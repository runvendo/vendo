// @vitest-environment jsdom
// ENG-227 — theme-token effectiveness. The contract lists brand axes the chrome
// was ignoring: density (emitted, unread), radius.small / radius.large (never
// referenced — only medium), typography.headingFamily (unused by chrome), and
// baseSize (didn't scale the hardcoded px literals). Plus the raw-accent user
// bubble read as iMessage-blue on a mostly-white host. This suite would have
// caught the inert tokens: it pins that each axis both (1) changes the vars
// themeCssVariables emits and lands on .vendo-root, and (2) is actually read by
// the shipped sheet — and that the user bubble fill is neutral, not raw accent.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { VendoTheme } from "@vendoai/core";
import { defaultVendoTheme, themeCssVariables } from "../src/theme.js";
import { VendoProvider, createVendoClient } from "../src/index.js";
import { ChromeRoot } from "../src/chrome/chrome-root.js";
import { CHROME_CSS } from "../src/chrome/chrome-css.js";

function rootFor(theme: Partial<VendoTheme>): HTMLElement {
  const client = createVendoClient({ baseUrl: "http://vendo.test/api/vendo" });
  const { container } = render(
    <VendoProvider client={client} theme={theme}>
      <ChromeRoot automaticPolicyNotice={false}>content</ChromeRoot>
    </VendoProvider>,
  );
  const root = container.querySelector<HTMLElement>(".vendo-root");
  expect(root).not.toBeNull();
  return root!;
}

describe("themeCssVariables — inert tokens now emit distinct output", () => {
  it("density changes the emitted spacing scale", () => {
    const comfortable = themeCssVariables(defaultVendoTheme);
    const compact = themeCssVariables({ ...defaultVendoTheme, density: "compact" });
    expect(compact["--vendo-density"]).toBe("compact");
    expect(compact["--vendo-density-card-padding"]).not.toBe(comfortable["--vendo-density-card-padding"]);
    expect(compact["--vendo-density-table-padding"]).not.toBe(comfortable["--vendo-density-table-padding"]);
  });

  it("radius.small and radius.large are emitted, not just medium", () => {
    const vars = themeCssVariables({
      ...defaultVendoTheme,
      radius: { small: "3px", medium: "10px", large: "28px" },
    });
    expect(vars["--vendo-radius-small"]).toBe("3px");
    expect(vars["--vendo-radius-large"]).toBe("28px");
  });

  it("headingFamily is emitted when the host sets one", () => {
    expect(themeCssVariables(defaultVendoTheme)["--vendo-heading-family"]).toBeUndefined();
    const vars = themeCssVariables({
      ...defaultVendoTheme,
      typography: { ...defaultVendoTheme.typography, headingFamily: "'Newsreader', serif" },
    });
    expect(vars["--vendo-heading-family"]).toBe("'Newsreader', serif");
  });

  it("baseSize anchors a --vendo-base-size the scale can key off", () => {
    const vars = themeCssVariables({
      ...defaultVendoTheme,
      typography: { ...defaultVendoTheme.typography, baseSize: "20px" },
    });
    expect(vars["--vendo-base-size"]).toBe("20px");
    expect(vars["--vendo-font-size"]).toBe("20px");
  });
});

describe("ChromeRoot carries the changed tokens onto .vendo-root", () => {
  it("a distinct density/radius/headingFamily/baseSize theme lands on the root", () => {
    const root = rootFor({
      density: "compact",
      radius: { small: "3px", medium: "10px", large: "28px" },
      typography: { fontFamily: "system-ui", baseSize: "19px", headingFamily: "'Newsreader', serif" },
    });
    expect(root.style.getPropertyValue("--vendo-density")).toBe("compact");
    expect(root.style.getPropertyValue("--vendo-radius-small")).toBe("3px");
    expect(root.style.getPropertyValue("--vendo-radius-large")).toBe("28px");
    expect(root.style.getPropertyValue("--vendo-heading-family")).toBe("'Newsreader', serif");
    expect(root.style.getPropertyValue("--vendo-base-size")).toBe("19px");
  });
});

describe("the sheet actually reads the wired tokens", () => {
  it("bridges radius.small / radius.large instead of only medium", () => {
    expect(CHROME_CSS).toContain("--vendo-radius-sm: var(--vendo-radius-small");
    expect(CHROME_CSS).toContain("--vendo-radius-lg: var(--vendo-radius-large");
    // …and consumes them on real surfaces (small chips/code, large panels).
    expect(CHROME_CSS).toContain("var(--vendo-radius-sm)");
    expect(CHROME_CSS).toContain("var(--vendo-radius-lg)");
  });

  it("applies headingFamily to chrome headings", () => {
    expect(CHROME_CSS).toContain("--vendo-heading-font: var(--vendo-heading-family");
    expect(CHROME_CSS).toContain("font-family: var(--vendo-heading-font)");
  });

  it("scales type off baseSize and drives density spacing", () => {
    expect(CHROME_CSS).toContain("--vendo-base-size: var(--vendo-font-size");
    expect(CHROME_CSS).toContain("calc(var(--vendo-base-size)");
    expect(CHROME_CSS).toContain("var(--vendo-density-card-padding)");
    expect(CHROME_CSS).toContain("var(--vendo-density-table-padding)");
  });
});

describe("tokenized colors — no scattered literals", () => {
  it("ceremony/critical/voice amber all derive from the warn family", () => {
    // Each amber value now appears exactly once — in its single token
    // definition — instead of being re-hardcoded across ceremony buttons,
    // voice consent and the a11y block. #c07d1a (a dead toast fallback) is gone.
    expect(CHROME_CSS).not.toContain("#c07d1a");
    const once = (needle: string) => (CHROME_CSS.split(needle).length - 1);
    expect(once("#7a5000")).toBe(1); // --vendo-warn
    expect(once("#8a6a2e")).toBe(1); // --vendo-warn-text
    expect(once("#a97e2f")).toBe(1); // --vendo-warn-fill-critical
    expect(CHROME_CSS).toContain("--vendo-warn-text:");
    expect(CHROME_CSS).toContain("--vendo-warn-on-fill:");
  });

  it("no unshipped brand mono font is hardcoded", () => {
    expect(CHROME_CSS).not.toContain("Geist Mono");
    expect(CHROME_CSS).toContain("--vendo-font-mono:");
  });

  it("dead --vendo-warning typo vars are replaced by the real warn tokens", () => {
    expect(CHROME_CSS).not.toContain("--vendo-warning");
  });
});

describe("neutral user bubbles — accent never paints the whole turn", () => {
  it("the user turn fills with the neutral bubble token, not raw accent", () => {
    const userRule = CHROME_CSS.slice(
      CHROME_CSS.indexOf(".fl-turn-user {"),
      CHROME_CSS.indexOf(".fl-usertext"),
    );
    expect(userRule).toContain("background: var(--vendo-user-bubble)");
    expect(userRule).not.toContain("var(--vendo-accent)");
  });

  it("the neutral bubble token is a fg/surface mix, not the accent color", () => {
    const decl = CHROME_CSS.slice(CHROME_CSS.indexOf("--vendo-user-bubble:"));
    const value = decl.slice(0, decl.indexOf(";"));
    expect(value).toContain("var(--vendo-fg)");
    expect(value).toContain("var(--vendo-surface)");
    expect(value).not.toContain("--vendo-accent");
  });

  it("accent is still reserved for the send button and focus rings", () => {
    expect(CHROME_CSS).toContain(".fl-send { border-radius: 50%; background: var(--vendo-accent)");
    expect(CHROME_CSS).toContain(":focus-visible { outline: 2px solid var(--vendo-accent)");
  });
});
