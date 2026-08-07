// @vitest-environment jsdom
// §10.1 — the pin NUDGE, the mockup's one new visual beat (founder-approved,
// 2026-08-04). When a build SETTLES and its app has not been pinned yet, the
// pin affordance that already exists (`.fl-barpin`, both sites) draws a quiet
// invitation; taking the pin resolves it to a settled accent state. An
// invitation, never an action — the agent never pins.
//
// The state rides ONE attribute on the EXISTING button (`data-vendo-pin`), the
// same shape `data-vendo-suggest` uses on the expand affordance: no new button,
// no new component, no toast.
import type { Thread } from "@vendoai/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoThread, type VendoThreadProps } from "../../src/chrome/index.js";
import { ThreadPart } from "../../src/chrome/thread/parts.js";
import { createWireServer } from "../wire-server.js";

/** A `data-vendo-view` part, the shape the stream emits. */
function view(appId: string, name: string, streaming = false) {
  return {
    type: "data-vendo-view",
    data: {
      appId,
      payload: {
        formatVersion: "vendo-genui/v2",
        name,
        root: "root",
        nodes: [{ id: "root", component: "Text", props: { text: `${name} body` } }],
        ...(streaming ? { streaming: true } : {}),
      },
    },
  } as unknown as Parameters<typeof ThreadPart>[0]["part"];
}

const pinButton = () => screen.getByRole("button", { name: "Pin to dashboard" });
const pinState = () => pinButton().getAttribute("data-vendo-pin");

describe("the pin nudge on the in-thread card", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await wire.close();
  });

  /** Every case uses its OWN app id: "pinned" is a module-scope fact (the pin
   *  bus), so a shared id would carry one case's pin into the next. */
  function card(appId: string, restored: boolean, streaming = false) {
    render(
      <VendoProvider client={client} onPin={() => {}}>
        <ThreadPart part={view(appId, "Spending board", streaming)} partKey="p0" role="assistant" restored={restored} />
      </VendoProvider>,
    );
  }

  it("a build that just settled invites the pin", () => {
    card("app_nudge_live", false);
    expect(pinState()).toBe("invite");
  });

  it("a card still BUILDING has no pin at all, so the nudge can never join the build's one moving thing", () => {
    card("app_nudge_building", false, true);
    expect(screen.queryByRole("button", { name: "Pin to dashboard" })).toBeNull();
  });

  it("restored history does not nudge — the invitation belongs to the build that just landed", () => {
    card("app_nudge_restored", true);
    expect(pinState()).toBeNull();
  });

  it("taking the pin resolves the invitation to a settled state", () => {
    card("app_nudge_taken", false);
    fireEvent.click(pinButton());
    expect(pinState()).toBe("pinned");
  });

  it("a pin taken once stays settled on the next mount of the same app (the pin bus)", () => {
    card("app_nudge_remount", false);
    fireEvent.click(pinButton());
    cleanup();
    card("app_nudge_remount", false);
    expect(pinState()).toBe("pinned");
  });
});

describe("the pin nudge on the split-view stage", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await wire.close();
  });

  const NOW = "2026-08-04T12:00:00.000Z";

  function threadClient(thread: Thread): VendoClient {
    return {
      ...client,
      threads: {
        ...client.threads,
        get: async id => (id === thread.id ? thread : client.threads.get(id)),
        list: async () => [{ id: thread.id, title: thread.subject, updatedAt: thread.updatedAt }],
      },
    };
  }

  it("the stage bar's pin carries the same invitation — the workspace is the mockup's own pin", async () => {
    const thread = {
      id: "thr_stage_nudge",
      subject: "browser-user",
      createdAt: NOW,
      updatedAt: NOW,
      messages: [{ id: "msg_view", role: "assistant", parts: [view("app_stage_nudge", "Goals board")] }],
    } as unknown as Thread;
    const ThreadWithEmbed = (props: VendoThreadProps) => <VendoThread {...props} threadId={thread.id} />;
    render(
      <VendoProvider client={threadClient(thread)} onPin={() => {}}>
        <VendoOverlay defaultOpen thread={ThreadWithEmbed} />
      </VendoProvider>,
    );
    await screen.findAllByText("Goals board body");
    fireEvent.click(screen.getByRole("button", { name: "Expand workspace" }));
    const stagePin = document.querySelector(".fl-stage-pin")!;
    expect(stagePin.getAttribute("data-vendo-pin")).toBe("invite");
  });
});
