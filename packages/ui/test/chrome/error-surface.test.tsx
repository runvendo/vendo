// @vitest-environment jsdom
// ENG-214 — a broken turn must surface VISIBLY in the thread (the banner), not
// only through the visually-hidden status span. Ruling 16: the RECOVERY lives in
// the conversation (the turn's Regenerate / Edit actions), never in a bespoke
// failure control of the banner's own.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoThread } from "../../src/chrome/index.js";
import { turnErrorSentence } from "../../src/chrome/thread/message-data.js";
import { createWireServer } from "../wire-server.js";

function sendFromComposer(text: string) {
  const composer = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.keyDown(composer, { key: "Enter" });
}

/** C4 — the ONE gate both error surfaces read, against the three strings the
 *  agent's `wireErrorMessage` actually puts on the wire. */
describe("the turn-error gate (C4)", () => {
  // ⚠️⚠️ DEFECT-PINNING TEST EDIT (CR-3). This asserted that the OPERATOR's
  // sentence reached the reader, which is the defect: the "Vendo: " marker says
  // a string is safe on the WIRE, never that it was written for a person.
  // `packages/vendo/src/sandbox.ts` raises "Vendo Cloud sandbox sbx_… is gone
  // (destroyed by the provider): <raw provider message>" through this exact
  // path — an id and a nested exception, inside a turn. The reader now gets
  // copy chosen by the VendoError CODE (the refusalCopy pattern).
  it("answers by CODE, never with the operator's own sentence", () => {
    expect(turnErrorSentence("Vendo: this deployment's plan does not include app machines (cloud-required)"))
      .toBe("That isn’t turned on for this workspace yet — nothing was changed.");
  });

  it("never prints an id or a nested provider exception from a Vendo-prefixed string", () => {
    const sandbox = "Vendo: Vendo Cloud sandbox sbx_9f21 is gone (destroyed by the provider):"
      + " Error: 404 sandbox not found at https://api.provider.test/v1/sandboxes/sbx_9f21 (not-found)";
    const sentence = turnErrorSentence(sandbox)!;
    expect(sentence).toBe("What that was about isn’t there any more — nothing was changed.");
    expect(sentence).not.toContain("sbx_9f21");
    expect(sentence).not.toContain("provider");
    expect(sentence).not.toContain("http");
  });

  it("strips EVERY trailing code token — a doubly-gated message left one on screen", () => {
    expect(turnErrorSentence("Vendo: boom (validation) (cloud-required)"))
      .toBe("That isn’t turned on for this workspace yet — nothing was changed.");
  });

  it("says nothing for a Vendo-prefixed string carrying no code at all", () => {
    // The surfaces' own headline ("Something went wrong…") is the honest
    // answer; printing the wire instead of it is the defect.
    expect(turnErrorSentence("Vendo: something happened in run_18f0")).toBeUndefined();
  });

  it("keeps the ONE crafted sentence that is consumer copy — the meter refusal", () => {
    const meter = "Vendo: Vendo Cloud paused usage — the $5.00 included this billing period is used up "
      + "($5.00 of $5.00 used; resets 2026-08-01). "
      + "Upgrade your plan (https://console.vendo.run/billing) "
      + "or bring your own infrastructure (https://docs.vendo.run/byo). (cloud-required)";
    expect(turnErrorSentence(meter)).toBe(
      "Vendo Cloud paused usage — the $5.00 included this billing period is used up "
      + "($5.00 of $5.00 used; resets 2026-08-01). "
      + "Upgrade your plan (https://console.vendo.run/billing) "
      + "or bring your own infrastructure (https://docs.vendo.run/byo).",
    );
  });

  it("says NOTHING for an unprefixed string — the generic gate output and any raw one", () => {
    expect(turnErrorSentence("An error occurred while generating the response.")).toBeUndefined();
    expect(turnErrorSentence("TypeError: fetch failed at https://api.provider.test?key=sk-live-42"))
      .toBeUndefined();
    expect(turnErrorSentence(undefined)).toBeUndefined();
  });
});

describe("visible error surface + retry (ENG-214)", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // ai-SDK's useChat logs stream errors; the failures here are deliberate.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    consoleError.mockRestore();
    await wire.close();
  });

  it("shows the error banner on a mid-stream failure and keeps the aria announcement", async () => {
    wire.state.streamFailures = 1;
    const view = render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    sendFromComposer("Hello");
    const banner = (await screen.findByText(/Something went wrong/)).closest(".fl-error");
    expect(banner).toBeTruthy();
    // Friendly copy, not the raw transport error string.
    expect(banner?.textContent).toContain("Something went wrong");
    expect(banner?.textContent).not.toContain("connection reset mid-stream");
    // The visually-hidden live announcement (a11y) still carries the error.
    const status = view.container.querySelector('[role="status"]');
    expect(status?.textContent).toMatch(/^error:/);
  });

  it("renders the Vendo detail line when the error part is Vendo-shaped", async () => {
    wire.state.streamFailures = 1;
    wire.state.streamFailureText = "Vendo: this deployment's plan does not include app machines (cloud-required)";
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    sendFromComposer("Hello");
    const banner = (await screen.findByText(/Something went wrong/)).closest(".fl-error");
    expect(banner?.textContent).toContain("Something went wrong");
    // ⚠️⚠️ DEFECT-PINNING TEST EDIT (CR-3): this required the OPERATOR's
    // sentence in the banner. It is the developer's half of the string and now
    // stays in the server log and the console; the banner carries the copy for
    // this VendoError code.
    expect(banner?.textContent).toContain("That isn’t turned on for this workspace yet");
    expect(banner?.textContent).not.toContain("does not include app machines");
    expect(banner?.textContent).not.toContain("(cloud-required)");
  });

  it("a meter-exhausted refusal ends the turn with the banner naming the meter, reset date, and both exits", async () => {
    // Pricing v3 (spec §5): the agent's wireErrorMessage renders the Cloud
    // refusal body as one crafted sentence; the thread shows it on the same
    // Vendo-detail rail as any safe stream error, and the turn ends (Retry).
    wire.state.streamFailures = 1;
    wire.state.streamFailureText =
      "Vendo: Vendo Cloud paused usage — the $5.00 included this billing period is used up "
      + "($5.00 of $5.00 used; resets 2026-08-01). "
      + "Upgrade your plan (https://console.vendo.run/billing) "
      + "or bring your own infrastructure (https://docs.vendo.run/byo). (cloud-required)";
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    sendFromComposer("Hello");
    const banner = (await screen.findByText(/Something went wrong/)).closest(".fl-error");
    expect(banner?.textContent).toContain("Something went wrong");
    expect(banner?.textContent).toContain("Vendo Cloud paused usage");
    expect(banner?.textContent).toContain("resets 2026-08-01");
    expect(banner?.textContent).toContain("Upgrade your plan (https://console.vendo.run/billing)");
    expect(banner?.textContent).toContain("bring your own infrastructure (https://docs.vendo.run/byo)");
  });

  it("never prints non-Vendo error text in the banner (raw transport strings stay hidden)", async () => {
    wire.state.streamFailures = 1;
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    sendFromComposer("Hello");
    const banner = (await screen.findByText(/Something went wrong/)).closest(".fl-error");
    expect(banner?.textContent).toContain("Something went wrong");
    expect(banner?.textContent).not.toContain("connection reset");
  });

  it("renders a failed turn's error INLINE where the reply would be, and survives a reload", async () => {
    // self-serve P — the transient error chunk is gone on the next mount, so a
    // reloaded thread used to show the question answered by a blank assistant
    // turn. The agent now writes the same gated string into the turn, and the
    // transcript renders it in the failed-beat vocabulary.
    wire.state.threads.set("thr_failed", {
      id: "thr_failed",
      subject: "user_1",
      messages: [
        { id: "msg_ask", role: "user", parts: [{ type: "text", text: "Show me a dashboard" }] },
        {
          id: "msg_failed",
          role: "assistant",
          parts: [{
            type: "data-vendo-turn-error",
            data: { message: "Vendo: Vendo found no model key. Run `vendo login` for a free dev key. (validation)" },
          }],
        },
      ],
      createdAt: "2026-07-11T12:00:00.000Z",
      updatedAt: "2026-07-11T12:00:00.000Z",
    } as never);
    render(<VendoProvider client={client}><VendoThread threadId="thr_failed" /></VendoProvider>);

    // The user's message stays, and the failure reads where the answer would be
    // — with no live thread.error, so nothing but the turn itself is saying it.
    expect(await screen.findByText("Show me a dashboard")).toBeTruthy();
    // ⚠️⚠️ DEFECT-PINNING TEST EDIT (CR-3): this pinned "Vendo found no model
    // key. Run `vendo login` for a free dev key." INSIDE a user's transcript —
    // a shell command in a consumer surface, admitted by the prefix alone.
    const notice = await screen.findByText(/I couldn’t make that request work/);
    expect(notice.closest("[data-vendo-turn-error]")).toBeTruthy();
    expect(notice.textContent).not.toContain("vendo login");
    // The wire's "Vendo: " marker is plumbing, never shown to the reader.
    expect(notice.textContent).not.toContain("Vendo: ");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("retries a mid-stream failure through Regenerate, without duplicating messages", async () => {
    // ⚠️ TEST EDIT (ruling 16): this clicked the banner's own Retry button. §15
    // gives the conversation ONE recovery path, and it is the turn's Regenerate
    // action — the same call the banner button made. The banner states what
    // happened; the turn offers the redo.
    wire.state.streamFailures = 1;
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    sendFromComposer("Hello");
    await screen.findByText(/Something went wrong/);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate" }));

    expect(await screen.findByText("Turn complete")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Something went wrong/)).toBeNull());
    // The user turn is not duplicated, and the cut partial answer was replaced.
    expect(screen.getAllByText("Hello")).toHaveLength(1);
    expect(screen.queryByText("Starting an answer that will be cut")).toBeNull();
    const turns = wire.requests.filter(request => request.method === "POST" && request.path === "/threads");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.body).toMatchObject({
      message: { role: "user", parts: [{ type: "text", text: "Hello" }] },
    });
  });

  it("shows the banner on a failed send, and Edit re-issues the same turn", async () => {
    // ⚠️ TEST EDIT (ruling 16): a failed SEND has no assistant turn to
    // regenerate, so the recovery path is the last user turn's own Edit action —
    // the composer refills with the message and sending re-issues it. No bespoke
    // failure control, exactly as §15 says.
    wire.state.failures.push({ method: "POST", path: "/threads", code: "internal", message: "boom", status: 500 });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    sendFromComposer("Hello again");
    await screen.findByText(/Something went wrong/);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Edit message" }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value)
      .toBe("Hello again"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });

    expect(await screen.findByText("Turn complete")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Something went wrong/)).toBeNull());
    expect(screen.getAllByText("Hello again")).toHaveLength(1);
    const turns = wire.requests.filter(request => request.method === "POST" && request.path === "/threads");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.body).toMatchObject({
      message: { role: "user", parts: [{ type: "text", text: "Hello again" }] },
    });
  });
});
