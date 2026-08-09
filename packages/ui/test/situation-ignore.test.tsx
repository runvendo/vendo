// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VendoProvider } from "../src/index.js";
import { ChromeRoot } from "../src/chrome/index.js";
import { captureScreen } from "../src/situation.js";

afterEach(() => {
  document.querySelector("h1")?.remove();
});

/** Decision 4 (spec 2026-08-05) — the widget excludes itself from the snapshot:
 *  every chrome boundary carries data-vendo-ignore on its own root. */
describe("widget self-exclusion", () => {
  it("ChromeRoot carries data-vendo-ignore, so widget content never reaches the capture", () => {
    document.body.insertAdjacentHTML("afterbegin", "<h1>Host page</h1>");
    render(
      <VendoProvider>
        <ChromeRoot>
          <button>Ask Vendo anything</button>
        </ChromeRoot>
      </VendoProvider>,
    );
    expect(document.querySelector(".vendo-root")?.hasAttribute("data-vendo-ignore")).toBe(true);
    const screen = captureScreen();
    expect(screen).toContain("Host page");
    expect(screen).not.toContain("Ask Vendo anything");
  });
});
