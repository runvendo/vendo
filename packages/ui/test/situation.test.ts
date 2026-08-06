// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { captureScreen, currentSituation, publishSituation, retireSituation } from "../src/situation.js";

afterEach(() => {
  document.body.innerHTML = "";
  document.title = "";
});

describe("captureScreen (spec 2026-08-05 §2)", () => {
  it("prepends URL + title and captures the page's accessibility tree", () => {
    document.title = "Maple — Checkout";
    document.body.innerHTML = `<main><h1>Checkout</h1><button>Pay now</button></main>`;
    const screen = captureScreen();
    expect(screen).toBeDefined();
    const [url, title] = screen!.split("\n");
    expect(url).toBe("http://localhost:3000/");
    expect(title).toBe("Maple — Checkout");
    expect(screen).toContain("Checkout");
    expect(screen).toContain("Pay now");
  });

  it("excludes data-vendo-ignore elements and their children, restoring the DOM after", () => {
    document.body.innerHTML = [
      "<h1>Host page</h1>",
      '<div data-vendo-ignore=""><button>Vendo launcher</button></div>',
      '<div data-vendo-ignore="" aria-hidden="false"><p>Widget panel text</p></div>',
    ].join("");
    const screen = captureScreen();
    expect(screen).toContain("Host page");
    expect(screen).not.toContain("Vendo launcher");
    expect(screen).not.toContain("Widget panel text");
    // The walk's temporary aria-hidden marks are gone; the host's own value survives.
    expect(document.querySelector("[data-vendo-ignore]")!.getAttribute("aria-hidden")).toBeNull();
    expect(document.querySelectorAll('[aria-hidden="false"]')).toHaveLength(1);
  });

  it("caps the payload at 8 KB, preferring main content", () => {
    const noise = Array.from({ length: 400 }, (_, i) => `<p>aside filler line ${i} ${"y".repeat(40)}</p>`).join("");
    document.body.innerHTML = `<aside>${noise}</aside><main><h1>Spending report</h1></main>`;
    const screen = captureScreen();
    expect(screen!.length).toBeLessThanOrEqual(8192);
    expect(screen).toContain("Spending report");
    expect(screen).not.toContain("aside filler line 399");
  });

  it("hard-truncates when even main content is over budget", () => {
    const noise = Array.from({ length: 400 }, (_, i) => `<p>main filler line ${i} ${"y".repeat(40)}</p>`).join("");
    document.body.innerHTML = `<main>${noise}</main>`;
    const screen = captureScreen();
    expect(screen!.length).toBeLessThanOrEqual(8192);
    expect(screen).toContain("…[truncated]");
  });

  // A header long enough to leave a positive budget SMALLER than the truncation
  // marker: `budget - marker` then goes negative, and a negative `slice` end
  // counts from the END of the tree — keeping nearly all of it instead of none.
  it("still caps the payload when the budget is smaller than the truncation marker", () => {
    document.title = "T".repeat(8160); // budget === 8, marker is 13 chars
    const noise = Array.from({ length: 400 }, (_, i) => `<p>main filler line ${i} ${"y".repeat(40)}</p>`).join("");
    document.body.innerHTML = `<main>${noise}</main>`;
    const screen = captureScreen();
    expect(screen!.length).toBeLessThanOrEqual(8192);
  });
});

describe("the published-situation registry (spec 2026-08-05 §3)", () => {
  it("merges published entries into one send and drops retired ones", () => {
    const key = Symbol("test");
    publishSituation(key, { cart: 3, step: "payment" });
    expect(currentSituation(false)).toEqual({ cart: 3, step: "payment" });
    retireSituation(key);
    expect(currentSituation(false)).toBeUndefined();
  });

  it("captures the screen only when capture is on", () => {
    document.body.innerHTML = "<h1>Page</h1>";
    expect(currentSituation(false)).toBeUndefined();
    expect(currentSituation(true)).toMatchObject({ screen: expect.stringContaining("Page") });
  });
});
