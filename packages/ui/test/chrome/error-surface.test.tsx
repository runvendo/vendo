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
