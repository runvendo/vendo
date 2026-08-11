// @vitest-environment jsdom
// ENG-214 — a broken turn must surface VISIBLY in the thread (the banner), not
// only through the visually-hidden status span. Ruling 16: the RECOVERY lives in
// the conversation (the turn's Regenerate / Edit actions), never in a bespoke
// failure control of the banner's own.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoThread } from "../../src/chrome/index.js";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";
import { turnErrorSentence } from "../../src/chrome/thread/message-data.js";
import { createWireServer } from "../wire-server.js";

function sendFromComposer(text: string) {
  const composer = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.keyDown(composer, { key: "Enter" });
}

/** C4 — the ONE gate both error surfaces read, against the strings the agent's
 *  `wireErrorMessage` actually puts on the wire. The marker is the whole gate:
 *  a prefixed sentence is OURS and reaches the reader unedited, code token and
 *  all; an unprefixed one is a raw provider string and never arrives. */
describe("the turn-error gate (C4)", () => {
  it("passes the operator's own sentence through, with its code", () => {
    expect(turnErrorSentence("Vendo: this deployment's plan does not include app machines (cloud-required)"))
      .toBe("this deployment's plan does not include app machines (cloud-required)");
  });

  it("keeps the sandbox id and the nested provider exception — the actionable half", () => {
    // `packages/vendo/src/sandbox.ts` raises this shape through this exact path.
    // The id is what makes it diagnosable, and a canned line threw it away.
    const sandbox = "Vendo: Vendo Cloud sandbox sbx_9f21 is gone (destroyed by the provider):"
      + " Error: 404 sandbox not found at https://api.provider.test/v1/sandboxes/sbx_9f21 (not-found)";
    expect(turnErrorSentence(sandbox)).toBe(
      "Vendo Cloud sandbox sbx_9f21 is gone (destroyed by the provider):"
      + " Error: 404 sandbox not found at https://api.provider.test/v1/sandboxes/sbx_9f21 (not-found)",
    );
  });

  it("strips no code token — a doubly-gated message keeps both, as they were written", () => {
    expect(turnErrorSentence("Vendo: boom (validation) (cloud-required)"))
      .toBe("boom (validation) (cloud-required)");
  });

  it("says the sentence for a Vendo-prefixed string carrying no code at all", () => {
    // The gate is the MARKER, never a recognized code: a code-keyed lookup
    // dropped every sentence whose code it did not know, headline and all.
    expect(turnErrorSentence("Vendo: something happened in run_18f0"))
      .toBe("something happened in run_18f0");
  });

  it("needs no special case for the meter refusal — it rides through with its code", () => {
    const meter = "Vendo: Vendo Cloud paused usage — the $5.00 included this billing period is used up "
      + "($5.00 of $5.00 used; resets 2026-08-01). "
      + "Upgrade your plan (https://console.vendo.run/billing) "
      + "or bring your own infrastructure (https://docs.vendo.run/byo). (cloud-required)";
    expect(turnErrorSentence(meter)).toBe(
      "Vendo Cloud paused usage — the $5.00 included this billing period is used up "
      + "($5.00 of $5.00 used; resets 2026-08-01). "
      + "Upgrade your plan (https://console.vendo.run/billing) "
      + "or bring your own infrastructure (https://docs.vendo.run/byo). (cloud-required)",
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
    // The detail rail carries the operator's sentence AS WRITTEN — the half a
    // reader can act on. Only the wire's marker comes off.
    expect(banner?.querySelector(".fl-error-detail")?.textContent)
      .toBe("this deployment's plan does not include app machines (cloud-required)");
    expect(banner?.textContent).not.toContain("Vendo: ");
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
    // The turn keeps the sentence the runtime wrote — `vendo login` is the one
    // thing that fixes this, and it is what the reader is owed.
    const notice = await screen.findByText(
      "Vendo found no model key. Run `vendo login` for a free dev key. (validation)",
    );
    expect(notice.closest("[data-vendo-turn-error]")).toBeTruthy();
    // The wire's "Vendo: " marker is plumbing, never shown to the reader.
    expect(notice.textContent).not.toContain("Vendo: ");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps the persisted failure's headline WHOLE, never ellipsized (jsdom can't measure layout, so pin the stylesheet contract)", () => {
    // The failure rendered its headline through `.fl-beat-label` — nowrap +
    // ellipsis, right for a progress line, wrong for content — inside a block
    // whose `max-width: 92%` resolved against the shrink-to-fit turn its OWN
    // text had just sized. The box came out narrower than the headline every
    // time, so a reloaded failure with no detail line under it read "The
    // response didn't f…" (PR #864 proof, measured at 144px).
    const block = /\.fl-buildfail \{[^}]*\}/.exec(CHROME_CSS)?.[0];
    expect(block, "expected a .fl-buildfail rule in CHROME_CSS").toBeTruthy();
    expect(block).not.toContain("max-width");
    const label = /\.fl-buildfail \.fl-beat-label \{[^}]*\}/.exec(CHROME_CSS)?.[0];
    expect(label, "expected the failure block to override the beat label's clip").toBeTruthy();
    expect(label).toContain("white-space: normal");
    expect(label).toContain("overflow: visible");
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
