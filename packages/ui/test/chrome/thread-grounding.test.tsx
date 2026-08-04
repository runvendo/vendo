// @vitest-environment jsdom
/**
 * LEAK 4's grounding carrier — the text part the MODEL reads and the person
 * never sees (the ✦ remix popover has to tell the agent WHICH view is being
 * remixed, and the identifier for it is an app id).
 *
 * THE HOLE the post-check found: the "never show this" mark lived only in
 * `providerMetadata`, and a store that persists a text part as `{ type, text }`
 * — which the wire contract permits — drops it. The marked part came back as an
 * ordinary text part, so a RELOADED transcript printed the app id and "edit last
 * message" seeded the composer with it. One reload, and the leak is back.
 */
import type { UIMessage } from "ai";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoThread } from "../../src/chrome/index.js";
import {
  AGENT_CONTEXT_MARK,
  agentContextPart,
  isAgentContext,
  userText,
} from "../../src/chrome/thread/message-data.js";
import { createWireServer } from "../wire-server.js";

const GROUNDING = 'The view being remixed is the "spending" slot, app app_9a3f2b1c.';

/** The part as a store that keeps only `{ type, text }` gives it back: the
 *  metadata is gone, and whatever rode in the TEXT is all that is left. */
const persisted = (): UIMessage["parts"][number] =>
  ({ type: "text", text: `${AGENT_CONTEXT_MARK} ${GROUNDING}` }) as UIMessage["parts"][number];

describe("the grounding part survives a {type,text}-only store", () => {
  it("the producer puts the mark where a {type,text} store cannot drop it", () => {
    const live = agentContextPart(GROUNDING);
    expect(isAgentContext(live)).toBe(true);
    expect(live.text.startsWith(AGENT_CONTEXT_MARK)).toBe(true);
    expect(live.text).toContain(GROUNDING);
  });

  it("is still recognized with the metadata gone", () => {
    const reloaded = persisted();
    expect("providerMetadata" in reloaded).toBe(false);
    expect(isAgentContext(reloaded)).toBe(true);
  });

  it("stays out of the text an edit re-seeds, before and after the round trip", () => {
    const message = (part: UIMessage["parts"][number]): UIMessage =>
      ({ id: "msg_1", role: "user", parts: [{ type: "text", text: "make it dark" }, part] }) as UIMessage;
    expect(userText(message(agentContextPart(GROUNDING)))).toBe("make it dark");
    expect(userText(message(persisted()))).toBe("make it dark");
  });
});

describe("a reloaded transcript never shows the grounding", () => {
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

  it("renders the person's words and nothing of the app id", async () => {
    wire.state.threads.set("thr_remix", {
      id: "thr_remix",
      subject: "user_1",
      messages: [{
        id: "msg_remix",
        role: "user",
        // As the store gave it back: the mark, no providerMetadata.
        parts: [{ type: "text", text: "make it dark" }, persisted()],
      }],
      createdAt: "2026-07-11T12:00:00.000Z",
      updatedAt: "2026-07-11T12:00:00.000Z",
    } as never);
    const view = render(<VendoProvider client={client}><VendoThread threadId="thr_remix" /></VendoProvider>);

    expect(await screen.findByText("make it dark")).toBeTruthy();
    await waitFor(() => expect(view.container.textContent).toContain("make it dark"));
    expect(view.container.textContent).not.toContain("app_9a3f2b1c");
    expect(view.container.textContent).not.toContain("vendo:context");
    expect(view.container.textContent).not.toContain("being remixed");
  });
});
