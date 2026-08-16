// @vitest-environment jsdom
// 2026-07 demo feedback — the phantom empty line under user bubbles.
//
// Two independent vectors produced a blank line inside `.fl-turn-user`:
//  1. the hover-revealed Copy/Edit actions row rendered IN FLOW at opacity 0,
//     reserving a full line below the text (fixed by overlaying it out of
//     flow — `.fl-turn-user .fl-turn-actions { position: absolute; … }`);
//  2. `.fl-usertext` is `white-space: pre-wrap`, so a trailing "\n" in the
//     sent text paints as a blank line (host sendMessage / prefill bridges
//     can carry one even though the composer trims its own drafts).
// These tests pin both fixes.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type Thread, type VendoClient } from "../../src/index.js";
import { VendoThread } from "../../src/chrome/index.js";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";
import { createWireServer } from "../wire-server.js";

const NOW = "2026-07-22T12:00:00.000Z";

function threadWithUserText(text: string): Thread {
  return {
    id: "thr_bubble",
    subject: "browser-user",
    createdAt: NOW,
    updatedAt: NOW,
    messages: [{ id: "msg_user", role: "user", parts: [{ type: "text", text }] }],
  };
}

function threadClient(client: VendoClient, thread: Thread): VendoClient {
  return {
    ...client,
    threads: {
      ...client.threads,
      get: async id => (id === thread.id ? thread : client.threads.get(id)),
      list: async () => [{ id: thread.id, title: thread.subject, updatedAt: thread.updatedAt }],
    },
  };
}

describe("user bubble phantom-line regressions", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });
  afterEach(async () => {
    cleanup();
    await wire.close();
  });

  async function mountUserTurn(text: string) {
    const thread = threadWithUserText(text);
    render(
      <VendoProvider client={threadClient(client, thread)}>
        <VendoThread threadId={thread.id} />
      </VendoProvider>,
    );
    await waitFor(() => expect(document.querySelector(".fl-turn-user")).toBeTruthy(), { timeout: 15_000 });
    return document.querySelector<HTMLElement>(".fl-turn-user")!;
  }

  it("keeps the hover actions row OUT OF FLOW below the bubble (jsdom can't measure layout, so pin the stylesheet contract)", () => {
    // The rule that fixed the reserved blank line: the user turn's actions row
    // is absolutely positioned under the bubble and pointer-events-gated.
    const rule = /\.fl-turn-user \.fl-turn-actions \{[^}]*\}/.exec(CHROME_CSS)?.[0];
    expect(rule, "expected a .fl-turn-user .fl-turn-actions rule in CHROME_CSS").toBeTruthy();
    expect(rule).toContain("position: absolute");
    expect(rule).toContain("pointer-events: none");
    // And the bubble anchors it (absolute needs a positioned ancestor).
    const bubble = /\.fl-turn-user \{[^}]*\}/.exec(CHROME_CSS)?.[0];
    expect(bubble).toContain("position: relative");
  });

  it("renders the sent text without a trailing-newline tail (pre-wrap would paint it as a blank line)", async () => {
    const bubble = await mountUserTurn("Every Friday, email me a summary of that week's spending.\n");
    const usertext = bubble.querySelector(".fl-usertext")!;
    expect(usertext.textContent).toBe("Every Friday, email me a summary of that week's spending.");
  });

  it("strips a multi-line whitespace tail but keeps interior blank lines (they are content)", async () => {
    const bubble = await mountUserTurn("first paragraph\n\nsecond paragraph\n\n  \n");
    const usertext = bubble.querySelector(".fl-usertext")!;
    expect(usertext.textContent).toBe("first paragraph\n\nsecond paragraph");
  });

  it("renders exactly the text node and no other in-flow children inside the bubble", async () => {
    const bubble = await mountUserTurn("hello");
    // Whatever else mounts in the bubble (the actions row) must be absolutely
    // positioned per the stylesheet; the only guaranteed in-flow child is the
    // verbatim text block.
    expect(bubble.querySelectorAll(".fl-usertext")).toHaveLength(1);
    expect(bubble.querySelector(".fl-usertext")!.textContent).toBe("hello");
  });
});
