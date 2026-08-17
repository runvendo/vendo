// @vitest-environment jsdom
// A host's limits policy denies a request — a message turned away before the
// turn starts, or an app generation refused mid-turn — and streams a
// `data-vendo-limit` part. The thread must say so: without it the person's
// message is answered by silence, which reads as a broken product rather than
// a cap they reached.
import { cleanup, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoThread } from "../../src/chrome/index.js";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { createWireServer } from "../wire-server.js";

describe("the limit card in the thread", () => {
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

  async function mountDenial(data: Record<string, unknown>, headline = "You’ve reached your limit") {
    const existing = wire.state.threads.get("thr_1")!;
    wire.state.threads.set("thr_1", {
      ...existing,
      messages: [...existing.messages, {
        id: "msg_limit",
        role: "assistant",
        parts: [{
          type: "data-vendo-limit",
          id: "vendo-limit:1",
          data,
        } as UIMessage["parts"][number]],
      }],
    });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText(headline);
    return document.querySelector("[data-vendo-limit]")!;
  }

  it("says the host's own sentence, verbatim", async () => {
    // The host set the cap, so the host is the only one who can say what it is
    // or how it lifts. Their sentence reaches the reader unedited.
    const card = await mountDenial({
      message: "You've used all 50 requests on the Free plan. It resets on the 1st.",
    });
    expect(card.textContent).toContain("You've used all 50 requests on the Free plan. It resets on the 1st.");
  });

  it("says the chrome's own line when the host wrote none", async () => {
    const card = await mountDenial({});
    expect(card.textContent).toContain("This request wasn’t run — nothing was changed.");
  });

  it("never calls a limit it could not CHECK a limit the person reached", async () => {
    // The meter read failed (Vendo Cloud busy), so nothing was counted. The card
    // still says the request did not run — it just does not blame the person for
    // a cap that was never measured.
    const card = await mountDenial(
      {
        message: "Vendo Cloud is busy right now, so this limit could not be checked — this is temporary, not a cap.",
        retryable: true,
      },
      "Couldn’t check your limit",
    );
    expect(card.textContent).toContain("this is temporary, not a cap");
    expect(card.textContent).not.toContain("You’ve reached your limit");
  });

  it("stays quiet: a cap reached is not a failure", async () => {
    // Nothing broke — the request never ran — so the card wears the beat's
    // ordinary register, not the ✕ and danger colour a failed build takes.
    const card = await mountDenial({ message: "Daily limit reached." });
    expect(card.querySelector(".fl-beat")).toBeTruthy();
    expect(card.querySelector(".fl-beat-error")).toBeNull();
    expect(card.querySelector(".fl-beat-x")).toBeNull();
    expect(document.querySelector("[data-vendo-build-failed]")).toBeNull();
  });
});
