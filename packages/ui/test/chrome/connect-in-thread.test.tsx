// @vitest-environment jsdom
// Harness-path defect (live E2E) — a connector call that ends `connect-required`
// on a HARNESS turn (vendo() / claudeCode()) is mirrored as a bare
// `tool-output-denied` (harnesses/src/wire.ts), so the thread's only record of
// the ask is the bridge's `data-vendo-connect` part. Nothing consumed it, so an
// unconnected service produced a silent denial and the promised connect card
// never appeared. The ENGINE path carries the typed outcome on the tool part AND
// writes the same part, so both shapes must add up to exactly one card.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoThread } from "../../src/chrome/index.js";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { createWireServer } from "../wire-server.js";

const connect = {
  connector: "composio",
  toolkit: "gmail",
  message: "Connect Gmail so the digest can land as a draft.",
};

/** The bridge's flat §16 part, in its wire envelope. */
const connectPart = (data: Record<string, unknown>) => ({
  type: "data-vendo-connect",
  data,
} as UIMessage["parts"][number]);

/** The harness mirror's tool part: `denied` carries no output at all. */
const deniedCall = () => ({
  type: "dynamic-tool",
  toolName: "gmail_send_email",
  toolCallId: "call_connect",
  state: "output-denied",
  input: { subject: "Your week at Maple" },
} as UIMessage["parts"][number]);

/** The engine path's tool part: the typed `connect-required` outcome IS the output. */
const connectRequiredCall = () => ({
  type: "dynamic-tool",
  toolName: "gmail_send_email",
  toolCallId: "call_connect",
  state: "output-available",
  input: { subject: "Your week at Maple" },
  output: { status: "connect-required", connect },
} as UIMessage["parts"][number]);

describe("connect card in the thread (both wire shapes)", () => {
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

  /** Append one assistant turn to the seeded thread and render it. */
  const renderTurn = (id: string, parts: UIMessage["parts"]) => {
    const existing = wire.state.threads.get("thr_1")!;
    wire.state.threads.set("thr_1", {
      ...existing,
      messages: [...existing.messages, { id, role: "assistant", parts }],
    });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
  };

  const cards = () => document.querySelectorAll("[data-vendo-connect-card]");

  it("renders the card from the data-vendo-connect part alone (the harness wire)", async () => {
    renderTurn("msg_connect_harness", [
      { type: "text", text: "I'll get that digest out." },
      deniedCall(),
      connectPart({ toolCallId: "call_connect", ...connect }),
    ]);

    // Brand-forward: the toolkit's display name, never the raw slug.
    const card = await screen.findByRole("article", { name: "Connect Gmail" });
    expect(card.textContent).toContain("Connect Gmail so the digest can land as a draft.");
    expect(screen.getByRole("button", { name: "Connect Gmail" })).toBeTruthy();
    expect(cards()).toHaveLength(1);
  });

  it("still renders the card from the typed tool outcome alone (the engine wire)", async () => {
    renderTurn("msg_connect_engine", [
      { type: "text", text: "I'll get that digest out." },
      connectRequiredCall(),
    ]);

    await screen.findByRole("article", { name: "Connect Gmail" });
    expect(cards()).toHaveLength(1);
  });

  it("renders ONE card when both shapes describe the same call (the engine wire writes both)", async () => {
    renderTurn("msg_connect_both", [
      { type: "text", text: "I'll get that digest out." },
      connectRequiredCall(),
      connectPart({ toolCallId: "call_connect", ...connect }),
    ]);

    await screen.findByRole("article", { name: "Connect Gmail" });
    expect(cards()).toHaveLength(1);
  });

  /** V5 — "Not now" is an answer, and the agent is the one waiting on it. It
      travels the same hidden carrier the Connected line uses: the Skipped row
      IS the visible record, so a user bubble would say it twice. */
  it("\"Not now\" tells the agent through hidden context and collapses to a re-offerable Skipped row", async () => {
    renderTurn("msg_connect_declined", [
      { type: "text", text: "I'll get that digest out." },
      connectRequiredCall(),
    ]);

    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));

    await waitFor(() => expect(wire.requests.some(request =>
      request.method === "POST"
      && request.path === "/threads"
      && JSON.stringify(request.body).includes("[vendo:context] Declined to connect Gmail."))).toBe(true));
    const card = screen.getByRole("article", { name: "Connect Gmail" });
    expect(card.getAttribute("data-vendo-connect-card")).toBe("skipped");
    expect(card.textContent).toContain("Skipped — Gmail isn’t connected");
    // The offer survives the decline, and the carrier never becomes a bubble.
    expect(screen.getByRole("button", { name: "Connect Gmail" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("vendo:context");
  });

  it("renders nothing for a malformed part (no toolkit)", async () => {
    renderTurn("msg_connect_malformed", [
      { type: "text", text: "Attempted a send." },
      connectPart({ toolCallId: "call_connect", connector: "composio", message: "Connect something." }),
    ]);

    await screen.findByText("Attempted a send.");
    expect(cards()).toHaveLength(0);
  });
});
