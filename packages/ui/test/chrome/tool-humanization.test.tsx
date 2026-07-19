// @vitest-environment jsdom
import type { ApprovalRequest, Thread } from "@vendoai/core";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type ToolMetaMap, type VendoClient } from "../../src/index.js";
import { ApprovalCard, VendoThread } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

const NOW = "2026-07-11T12:00:00.000Z";

function threadWith(parts: Thread["messages"][number]["parts"]): Thread {
  return {
    id: "thr_hz",
    subject: "browser-user",
    createdAt: NOW,
    updatedAt: NOW,
    messages: [{ id: "msg_hz", role: "assistant", parts }],
  };
}

function threadClient(client: VendoClient, thread: Thread): VendoClient {
  return {
    ...client,
    threads: {
      ...client.threads,
      get: async id => (id === thread.id ? thread : client.threads.get(id)),
      list: async () => [{ id: thread.id, title: thread.subject, updatedAt: thread.updatedAt }],
    },
  };
}

const doneTool = (toolCallId: string, input: unknown) => ({
  type: "dynamic-tool" as const,
  toolName: "host_listClientDocuments",
  toolCallId,
  state: "output-available" as const,
  input,
  output: { ok: true },
});

describe("tool beat humanization", () => {
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

  async function mount(parts: Thread["messages"][number]["parts"], tools?: ToolMetaMap) {
    const thread = threadWith(parts);
    render(
      <VendoProvider client={threadClient(client, thread)} tools={tools}>
        <VendoThread threadId={thread.id} />
      </VendoProvider>,
    );
    // Lane pick C1/8C — settled tool calls surface as the turn's sources row
    // (the beat stack left the transcript). Wait for the chips, label-agnostic.
    await waitFor(() => expect(document.querySelector(".fl-source")).toBeTruthy(), { timeout: 15_000 });
  }

  it("renders a humanized fallback label and no lifecycle string on the beat", { timeout: 20_000 }, async () => {
    await mount([doneTool("call_1", {})]);
    expect(screen.getByText("List client documents")).toBeTruthy();
    // The raw slug and the ai-SDK lifecycle string are never shown to end users.
    expect(screen.queryByText(/host_listClientDocuments/)).toBeNull();
    expect(screen.queryByText("output-available")).toBeNull();
    expect(screen.queryByText(/^Tool:/)).toBeNull();
  });

  it("prefers a host-supplied friendly label", { timeout: 20_000 }, async () => {
    await mount([doneTool("call_1", {})], {
      host_listClientDocuments: { label: "Look up client files" },
    });
    expect(screen.getByText("Look up client files")).toBeTruthy();
    expect(screen.queryByText("List client documents")).toBeNull();
  });

  it("collapses consecutive identical tool beats into one with a count", { timeout: 20_000 }, async () => {
    await mount([
      doneTool("call_1", { clientId: "c1" }),
      doneTool("call_2", { clientId: "c1" }),
      doneTool("call_3", { clientId: "c1" }),
    ]);
    const chips = screen.getAllByText("List client documents");
    expect(chips).toHaveLength(1);
    expect(screen.getByText("×3")).toBeTruthy();
  });

  it("does not collapse tool beats whose args differ", { timeout: 20_000 }, async () => {
    await mount([
      doneTool("call_1", { clientId: "c1" }),
      doneTool("call_2", { clientId: "c2" }),
    ]);
    expect(screen.getAllByText("List client documents")).toHaveLength(2);
    expect(screen.queryByText("×2")).toBeNull();
  });
});

describe("ApprovalCard humanization", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  const approval: ApprovalRequest = {
    id: "apr_1",
    call: { id: "call_1", tool: "host_delete_invoice", args: { invoiceId: "inv_42" } },
    descriptor: { name: "host_delete_invoice", description: "Permanently delete an invoice", inputSchema: {}, risk: "destructive" },
    inputPreview: "invoiceId=inv_42",
    ctx: { principal: { kind: "user", subject: "user_1" }, venue: "app", presence: "present", appId: "app_1" },
    createdAt: NOW,
  };

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });
  afterEach(async () => {
    cleanup();
    await wire.close();
  });

  it("humanizes the descriptor name into the title and aria-label", () => {
    render(<VendoProvider client={client}><ApprovalCard approval={approval} onDecide={() => undefined} /></VendoProvider>);
    const card = screen.getByLabelText("Approval for Delete invoice");
    expect(within(card).getByText("Delete invoice")).toBeTruthy();
    expect(screen.queryByText("host_delete_invoice")).toBeNull();
  });

  it("prefers a host-supplied label", () => {
    render(
      <VendoProvider client={client} tools={{ host_delete_invoice: { label: "Remove invoice" } }}>
        <ApprovalCard approval={approval} onDecide={() => undefined} />
      </VendoProvider>,
    );
    expect(screen.getByLabelText("Approval for Remove invoice")).toBeTruthy();
  });

  it("shows the humanized context byline by default and hides it when showContext is false", () => {
    const view = render(<VendoProvider client={client}><ApprovalCard approval={approval} onDecide={() => undefined} /></VendoProvider>);
    expect(screen.getByText(/Runs as you · asked in an app · app_1/)).toBeTruthy();
    view.rerender(<VendoProvider client={client}><ApprovalCard approval={approval} onDecide={() => undefined} showContext={false} /></VendoProvider>);
    expect(screen.queryByText(/Runs as you/)).toBeNull();
  });
});
