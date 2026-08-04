// @vitest-environment jsdom
// 0.4.4 cert defect B — a chat turn whose app build terminally failed streams
// a `data-vendo-build-failed` part (agent tool bridge); the thread must render
// it as a visible error beat carrying the classified reason, both live and on
// a restored thread. Before this, the failed build left NO transcript trace.
import { cleanup, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoThread } from "../../src/chrome/index.js";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { createWireServer } from "../wire-server.js";

describe("failed-build banner in the thread (0.4.4 cert defect B)", () => {
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

  it("renders the error beat from a restored thread", async () => {
    const failedTurn: UIMessage = {
      id: "msg_build_failed",
      role: "assistant",
      parts: [
        { type: "text", text: "Building your invoice tracker now." },
        {
          type: "data-vendo-build-failed",
          id: "vendo-build-failed:call_1",
          data: { toolCallId: "call_1", reason: "app build failed: generation failed" },
        } as UIMessage["parts"][number],
      ],
    };
    const existing = wire.state.threads.get("thr_1")!;
    wire.state.threads.set("thr_1", { ...existing, messages: [...existing.messages, failedTurn] });

    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);

    await screen.findByText("Couldn't build the app");
    const banner = document.querySelector("[data-vendo-build-failed]");
    expect(banner).toBeTruthy();
    expect(banner?.querySelector(".fl-beat-error")).toBeTruthy();
    // TEST CHANGE, STATED OUT LOUD: this line used to assert
    //   expect(banner?.textContent).toContain("app build failed: generation failed")
    // — it PINNED the defect the wave E2E caught. `reason` is the runtime's
    // sentence for whoever can fix the build (it reaches an end user carrying
    // `amount / sum(spending.data.amount)`, env-var names, "check the host
    // server log"), and asserting it renders verbatim demanded the developer's
    // voice on an end-user surface, against §16 law 3. What the banner must
    // carry is asserted in the consumer-voice test below.
  });

  it("renders nothing for a malformed part (no reason)", async () => {
    const malformedTurn: UIMessage = {
      id: "msg_build_failed_malformed",
      role: "assistant",
      parts: [
        { type: "text", text: "Attempted a build." },
        {
          type: "data-vendo-build-failed",
          data: { toolCallId: "call_1" },
        } as UIMessage["parts"][number],
      ],
    };
    const existing = wire.state.threads.get("thr_1")!;
    wire.state.threads.set("thr_1", { ...existing, messages: [...existing.messages, malformedTurn] });

    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);

    await screen.findByText("Attempted a build.");
    expect(document.querySelector("[data-vendo-build-failed]")).toBeNull();
  });
});

/** Spec §15 + §16 law 3 — the sentence a PERSON reads when a build fails.
 *
 *  The wave E2E caught the runtime's reason rendering verbatim in a real user's
 *  thread. Every one of these is a real string the runtime puts on this part,
 *  and every one of them is written for whoever can fix the build. */
describe("the build-failure sentence is the user's, not the developer's", () => {
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

  /** Verbatim from the live capture (fault-live/fault-03), plus the other two
      developer-voiced classes the runtime can put on this part. */
  const LEAKED: [string, string][] = [
    ["the honesty gate's teaching sentence (the live capture)",
      "app build failed: This app wasn't created, because it didn't pass the checks that keep an app honest:"
      + " The percent column uses the same raw `amount` field as its value instead of computing"
      + " `amount / sum(spending.data.amount)` — the `value` expression is a declarative string that the"
      + " DataTable does not evaluate, so every row will render the raw cent-scale integer (e.g. 285000)."],
    ["the no-model-key line",
      "app build failed: ANTHROPIC_API_KEY is set but @ai-sdk/anthropic is not installed in this app"],
    ["the build watchdog's line",
      "app build failed: the build never finished — the server-side build task stalled or died without"
      + " reporting a failure. Retry the request; if this repeats, check the host server log."],
  ];

  /** Code the user should never be shown: call syntax, dotted paths,
      snake_case/SCREAMING_SNAKE identifiers, backticked source. */
  const CODE_SHAPED = [/\w\(/, /[A-Za-z]\.[A-Za-z]/, /[A-Za-z]_[A-Za-z]/, /`/, /@[a-z-]+\//];

  async function mountFailure(reason: string) {
    const existing = wire.state.threads.get("thr_1")!;
    wire.state.threads.set("thr_1", {
      ...existing,
      messages: [...existing.messages.filter(message => message.id !== "msg_leak"), {
        id: "msg_leak",
        role: "assistant",
        parts: [{
          type: "data-vendo-build-failed",
          id: "vendo-build-failed:call_1",
          data: { toolCallId: "call_1", reason },
        } as UIMessage["parts"][number]],
      }],
    });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Couldn't build the app");
    return document.querySelector("[data-vendo-build-failed]")!.textContent ?? "";
  }

  it.each(LEAKED)("says what it means for the reader, not %s", async (_label, reason) => {
    const shown = await mountFailure(reason);
    expect(shown).toContain("I couldn't finish building that view");
    expect(shown).toContain("nothing was changed");
    for (const pattern of CODE_SHAPED) expect(shown, `${pattern} in: ${shown}`).not.toMatch(pattern);
  });

  // ONE sentence for every class, on purpose: the runtime's classification is a
  // substring scan over the concatenated findings, and `host_listScheduledPayments`
  // in a tool inventory makes an ordinary validation failure land as "quota
  // exhausted" (observed live 2026-08-03). Copy that branches on that label
  // would just tell a different lie.
  it("says the same true thing for a mislabelled class", async () => {
    expect(await mountFailure("app build failed: quota exhausted"))
      .toContain("I couldn't finish building that view");
  });
});

/** M20 — one failure, one ✕. The failed create's own beat sat directly above the
 *  build-failed block, so the transcript said the same thing twice in the same
 *  vocabulary. */
describe("a failed build narrates ONCE (M20)", () => {
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

  it("shows the build-failed block and NO second ✕ beat for the failed call", async () => {
    const failedTurn: UIMessage = {
      id: "msg_build_failed_twice",
      role: "assistant",
      parts: [
        { type: "text", text: "Building your invoice tracker now." },
        {
          type: "tool-vendo_apps_create",
          toolCallId: "call_1",
          state: "output-error",
          input: { intent: "invoice tracker" },
          errorText: "generation failed",
        } as unknown as UIMessage["parts"][number],
        {
          type: "data-vendo-build-failed",
          id: "vendo-build-failed:call_1",
          data: { toolCallId: "call_1", reason: "app build failed: generation failed" },
        } as UIMessage["parts"][number],
      ],
    };
    const existing = wire.state.threads.get("thr_1")!;
    wire.state.threads.set("thr_1", { ...existing, messages: [...existing.messages, failedTurn] });

    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);

    await screen.findByText("Couldn't build the app");
    // ONE error beat in the turn — the block's own.
    const failures = [...document.querySelectorAll(".fl-beat-error")];
    expect(failures).toHaveLength(1);
    expect(failures[0]?.closest("[data-vendo-build-failed]")).toBeTruthy();
    // And not the beat vocabulary for the call itself.
    expect(document.body.textContent).not.toContain("— couldn't finish");
  });

  it("still beats a failed call that has NO build-failed block (§15 keeps the ✕)", async () => {
    const failedTurn: UIMessage = {
      id: "msg_tool_failed",
      role: "assistant",
      parts: [
        {
          type: "tool-host_invoices_list",
          toolCallId: "call_2",
          state: "output-error",
          input: {},
          errorText: "boom",
        } as unknown as UIMessage["parts"][number],
      ],
    };
    const existing = wire.state.threads.get("thr_1")!;
    wire.state.threads.set("thr_1", { ...existing, messages: [...existing.messages, failedTurn] });

    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    expect(await screen.findByText(/couldn’t finish|couldn't finish/)).toBeTruthy();
  });
});
