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

  it("renders the error beat and the classified reason from a restored thread", async () => {
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
    expect(banner?.textContent).toContain("app build failed: generation failed");
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
