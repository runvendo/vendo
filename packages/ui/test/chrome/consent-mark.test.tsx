// @vitest-environment jsdom
/**
 * The consent register wears no badge.
 *
 * The in-chat approval card has been iconless for a while; the shield stayed on
 * the standing-access card, the resolved card and the modal, so the same ask
 * looked like two different products depending on where it was answered.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";
import { GrantSetCard } from "../../src/chrome/grant-set-card.js";
import { VendoProvider } from "../../src/index.js";

afterEach(cleanup);

describe("consent surfaces carry no shield", () => {
  it("heads the standing-access card with words alone", () => {
    render(
      <VendoProvider>
        <GrantSetCard
          name="Invoice watcher"
          permissions={[{ approvalId: "apr_1", tool: "host_email_send", risk: "write" }]}
          state="parked"
        />
      </VendoProvider>,
    );
    const head = document.querySelector(".fl-card-head");
    expect(head).not.toBeNull();
    expect(head!.textContent).toContain("Standing access");
    expect(head!.querySelector(".fl-card-ic")).toBeNull();
    expect(head!.querySelector("svg")).toBeNull();
  });

  it("leaves no dead mark in the modal's stylesheet", () => {
    expect(CHROME_CSS).not.toContain("fl-apmodal-mark");
  });
});
