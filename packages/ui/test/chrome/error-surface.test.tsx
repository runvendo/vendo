// @vitest-environment jsdom
// ENG-214 — a broken turn must surface VISIBLY in the thread (banner + retry),
// not only through the visually-hidden status span, and retry must re-issue
// the failed turn without duplicating the user's message.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoThread } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

function sendFromComposer(text: string) {
  const composer = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.keyDown(composer, { key: "Enter" });
}

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
    const retry = await screen.findByRole("button", { name: "Retry" });
    const banner = retry.closest(".fl-error");
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
    const retry = await screen.findByRole("button", { name: "Retry" });
    const banner = retry.closest(".fl-error");
    expect(banner?.textContent).toContain("Something went wrong");
    // The detail is OUR safe, operator-crafted message (agent wireErrorMessage
    // shape) — rendered without the wire prefix, code kept for support.
    expect(banner?.textContent).toContain("this deployment's plan does not include app machines (cloud-required)");
  });

  it("a meter-exhausted refusal ends the turn with the banner naming the meter, reset date, and both exits", async () => {
    // Pricing v3 (spec §5): the agent's wireErrorMessage renders the Cloud
    // refusal body as one crafted sentence; the thread shows it on the same
    // Vendo-detail rail as any safe stream error, and the turn ends (Retry).
    wire.state.streamFailures = 1;
    wire.state.streamFailureText =
      "Vendo: Vendo Cloud paused AI tokens — the allowance for this billing period is used up "
      + "(1,204,000 of 1,000,000 used; resets 2026-08-01). "
      + "Upgrade your plan (https://console.vendo.run/billing) "
      + "or bring your own infrastructure (https://docs.vendo.run/byo). (cloud-required)";
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    sendFromComposer("Hello");
    const retry = await screen.findByRole("button", { name: "Retry" });
    const banner = retry.closest(".fl-error");
    expect(banner?.textContent).toContain("Something went wrong");
    expect(banner?.textContent).toContain("Vendo Cloud paused AI tokens");
    expect(banner?.textContent).toContain("resets 2026-08-01");
    expect(banner?.textContent).toContain("Upgrade your plan (https://console.vendo.run/billing)");
    expect(banner?.textContent).toContain("bring your own infrastructure (https://docs.vendo.run/byo)");
  });

  it("never prints non-Vendo error text in the banner (raw transport strings stay hidden)", async () => {
    wire.state.streamFailures = 1;
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    sendFromComposer("Hello");
    const retry = await screen.findByRole("button", { name: "Retry" });
    const banner = retry.closest(".fl-error");
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
    const notice = await screen.findByText(/Vendo found no model key/);
    expect(notice.closest("[data-vendo-turn-error]")).toBeTruthy();
    // The wire's "Vendo: " marker is plumbing, never shown to the reader.
    expect(notice.textContent).not.toContain("Vendo: ");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("retries a mid-stream failure without duplicating messages", async () => {
    wire.state.streamFailures = 1;
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    sendFromComposer("Hello");
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Turn complete")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    // The user turn is not duplicated, and the cut partial answer was replaced.
    expect(screen.getAllByText("Hello")).toHaveLength(1);
    expect(screen.queryByText("Starting an answer that will be cut")).toBeNull();
    const turns = wire.requests.filter(request => request.method === "POST" && request.path === "/threads");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.body).toMatchObject({
      message: { role: "user", parts: [{ type: "text", text: "Hello" }] },
    });
  });

  it("shows the banner on a failed send and retry re-issues the same turn", async () => {
    wire.state.failures.push({ method: "POST", path: "/threads", code: "internal", message: "boom", status: 500 });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");

    sendFromComposer("Hello again");
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Turn complete")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(screen.getAllByText("Hello again")).toHaveLength(1);
    const turns = wire.requests.filter(request => request.method === "POST" && request.path === "/threads");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.body).toMatchObject({
      message: { role: "user", parts: [{ type: "text", text: "Hello again" }] },
    });
  });
});
