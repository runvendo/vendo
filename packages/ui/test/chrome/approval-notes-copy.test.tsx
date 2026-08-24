// @vitest-environment jsdom
import type { ApprovalRequest } from "@vendoai/core";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient } from "../../src/index.js";
import { ApprovalCard } from "../../src/chrome/index.js";

// The ask's quiet line, taken SOMEWHERE ELSE — pasted into a bug report, a
// message to support, a note to self. The " · " between its facts used to be
// drawn by CSS (`content` on a pseudo-element), and a browser hands generated
// content to the accessibility tree but never to the clipboard: the copied line
// read "…This makes a change you can’t undo, as you.asked in an app". A browser
// copies the TEXT, so the separator lives in the text — and inside the items,
// because a text node whose parent is the <ul> is a WCAG 1.3.1 failure (axe
// `list`, caught by e2e/accessibility.spec.ts).
//
// This file owns that contract for every surface that draws the line; the ask
// is the one with the most facts on it.

const client = createVendoClient({ baseUrl: "https://host.test/api/vendo" });

const approval: ApprovalRequest = {
  id: "apr_copy",
  call: { id: "call_copy", tool: "host_delete_invoice", args: { invoiceId: "inv_42", permanent: true } },
  descriptor: { name: "host_delete_invoice", description: "Delete invoice", inputSchema: {}, risk: "destructive" },
  inputPreview: "invoiceId=inv_42\npermanent=true",
  ctx: { principal: { kind: "user", subject: "user_1" }, venue: "app", presence: "present", appId: "app_1" },
  createdAt: "2026-07-11T12:00:00.000Z",
};

const FACTS = [
  "Invoice id: inv_42",
  "Permanent: Yes",
  "This makes a change you can’t undo, and it runs as you.",
  "asked in an app",
];

describe("the ask's quiet line, copied", () => {
  afterEach(cleanup);

  function line(): HTMLElement {
    const { container } = render(
      <VendoProvider client={client}>
        <ApprovalCard approval={approval} onDecide={() => undefined} />
      </VendoProvider>,
    );
    return container.querySelector<HTMLElement>("ul.fl-approval-sub")!;
  }

  it("reads as one separated sentence, never as facts run together", () => {
    expect(line().textContent).toBe(FACTS.join(" · "));
  });

  it("carries the separator inside the items, so the list only contains items", () => {
    const list = line();
    expect(Array.from(list.querySelectorAll("li")).map(item => item.textContent)).toEqual([
      "Invoice id: inv_42",
      " · Permanent: Yes",
      " · This makes a change you can’t undo, and it runs as you.",
      " · asked in an app",
    ]);
    // The WCAG 1.3.1 half: every child of the list is an item. A separator
    // between them copies just as well and fails axe's `list` rule.
    expect(Array.from(list.childNodes).every(node => node.nodeName === "LI")).toBe(true);
  });
});
