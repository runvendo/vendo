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
    // The reason the runtime classified, minus the wire marker.
    expect(banner?.textContent).toContain("generation failed");
    expect(banner?.textContent).not.toContain("app build failed:");
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

/** The sentence a person reads when a build fails: the runtime's own reason.
 *
 *  Every string below is a real one the runtime puts on this part, and each one
 *  names the thing that has to change — the package to install, the expression
 *  to fix, the retry to make. One canned first-person line used to stand in for
 *  all three, which threw exactly that half away. */
describe("the build-failure sentence is the runtime's own reason", () => {
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

  /** The wire marker the bridge puts in front of the reason (core's
      VENDO_APP_BUILD_FAILED_PREFIX + ":"): plumbing, so it comes off. */
  const MARKER = "app build failed: ";

  /** Verbatim from the live capture (fault-live/fault-03), plus the other two
      classes the runtime can put on this part. */
  const REASONS: [string, string][] = [
    ["the honesty gate's teaching sentence (the live capture)",
      "This app wasn't created, because it didn't pass the checks that keep an app honest:"
      + " The percent column uses the same raw `amount` field as its value instead of computing"
      + " `amount / sum(spending.data.amount)` — the `value` expression is a declarative string that the"
      + " DataTable does not evaluate, so every row will render the raw cent-scale integer (e.g. 285000)."],
    ["the no-model-key line",
      "ANTHROPIC_API_KEY is set but @ai-sdk/anthropic is not installed in this app"],
    ["the build watchdog's line",
      "the build never finished — the server-side build task stalled or died without"
      + " reporting a failure. Retry the request; if this repeats, check the host server log."],
  ];

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

  it.each(REASONS)("reaches the reader whole — %s", async (_label, reason) => {
    const shown = await mountFailure(`${MARKER}${reason}`);
    expect(shown).toContain(reason);
    expect(shown).not.toContain("app build failed");
  });

  // The one case with nothing of the runtime's to repeat: the marker arrived
  // with no reason behind it. The chrome then says the honest generic thing in
  // its own third-person voice rather than inventing a cause.
  it("falls back to the chrome's own notice when the reason carries no detail", async () => {
    expect(await mountFailure(MARKER.trimEnd()))
      .toContain("This view couldn’t be built — nothing was changed.");
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
          type: "tool-vendo_make",
          toolCallId: "call_1",
          state: "output-error",
          input: { request: "an invoice tracker" },
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
