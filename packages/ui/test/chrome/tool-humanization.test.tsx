// @vitest-environment jsdom
import type { ApprovalRequest, Thread } from "@vendoai/core";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type ToolMetaMap, type VendoClient } from "../../src/index.js";
import { ApprovalCard, BuildBeat, VendoThread } from "../../src/chrome/index.js";
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

/** A FAILED call is the one settled state that still leaves a transcript line
    (BuildBeat) — the surviving venue for label humanization checks. */
const erroredTool = (toolCallId: string, input: unknown) => ({
  type: "dynamic-tool" as const,
  toolName: "host_listClientDocuments",
  toolCallId,
  state: "output-error" as const,
  input,
  errorText: "boom",
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
    // Wait for the restored transcript to land (the assistant article mounts).
    await waitFor(() => expect(document.querySelector(".fl-turn-assistant")).toBeTruthy(), { timeout: 15_000 });
  }

  it("leaves NO transcript trace for a settled successful call — no sources chips, no raw slug", { timeout: 20_000 }, async () => {
    // 2026-07 demo feedback: the lane-8C sources chip row under assistant
    // turns is gone. A completed call's record lives in the Activity panel.
    await mount([doneTool("call_1", {})]);
    expect(document.querySelector(".fl-sources")).toBeNull();
    expect(document.querySelector(".fl-source")).toBeNull();
    expect(screen.queryByText("List client documents")).toBeNull();
    expect(screen.queryByText(/host_listClientDocuments/)).toBeNull();
    expect(screen.queryByText("output-available")).toBeNull();
  });

  it("renders a humanized fallback label and no lifecycle string on the failed-call beat", { timeout: 20_000 }, async () => {
    await mount([erroredTool("call_1", {})]);
    expect(screen.getByText(/List client documents/)).toBeTruthy();
    // The raw slug and the ai-SDK lifecycle string are never shown to end users.
    expect(screen.queryByText(/host_listClientDocuments/)).toBeNull();
    expect(screen.queryByText("output-error")).toBeNull();
    expect(screen.queryByText(/^Tool:/)).toBeNull();
  });

  it("prefers a host-supplied friendly label", { timeout: 20_000 }, async () => {
    await mount([erroredTool("call_1", {})], {
      host_listClientDocuments: { label: "Look up client files" },
    });
    expect(screen.getByText(/Look up client files/)).toBeTruthy();
    expect(screen.queryByText(/List client documents/)).toBeNull();
  });

  it("collapses consecutive identical failed beats into one with a count", { timeout: 20_000 }, async () => {
    await mount([
      erroredTool("call_1", { clientId: "c1" }),
      erroredTool("call_2", { clientId: "c1" }),
      erroredTool("call_3", { clientId: "c1" }),
    ]);
    expect(screen.getAllByText(/List client documents/)).toHaveLength(1);
    expect(screen.getByText("×3")).toBeTruthy();
  });

  it("does not collapse beats whose args differ", { timeout: 20_000 }, async () => {
    await mount([
      erroredTool("call_1", { clientId: "c1" }),
      erroredTool("call_2", { clientId: "c2" }),
    ]);
    expect(screen.getAllByText(/List client documents/)).toHaveLength(2);
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

  // ⚠️ TEST EDIT (M1 · Sentence), in this describe: the card's TITLE element is
  // gone — the humanized label is what the card ASKS ("Delete invoice?"), and
  // the aria-label is unchanged. Every expectation below is the same string with
  // its question mark.
  it("humanizes the descriptor name into the question and aria-label", () => {
    render(<VendoProvider client={client}><ApprovalCard approval={approval} onDecide={() => undefined} /></VendoProvider>);
    const card = screen.getByLabelText("Approval for Delete invoice");
    expect(within(card).getByText("Delete invoice?")).toBeTruthy();
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

  it("prefers the descriptor's authored title over the prettified name", () => {
    const titled: ApprovalRequest = {
      ...approval,
      descriptor: { ...approval.descriptor, title: "Delete this invoice for good" },
    };
    render(<VendoProvider client={client}><ApprovalCard approval={titled} onDecide={() => undefined} /></VendoProvider>);
    const card = screen.getByLabelText("Approval for Delete this invoice for good");
    expect(within(card).getByText("Delete this invoice for good?")).toBeTruthy();
    expect(screen.queryByText("Delete invoice?")).toBeNull();
  });

  it("still lets a host-supplied label win over the authored title", () => {
    const titled: ApprovalRequest = {
      ...approval,
      descriptor: { ...approval.descriptor, title: "Delete this invoice for good" },
    };
    render(
      <VendoProvider client={client} tools={{ host_delete_invoice: { label: "Remove invoice" } }}>
        <ApprovalCard approval={titled} onDecide={() => undefined} />
      </VendoProvider>,
    );
    expect(screen.getByLabelText("Approval for Remove invoice")).toBeTruthy();
  });

  it("shows the humanized context note by default and drops it when showContext is false", () => {
    // ⚠️ TEST EDIT (M1 · Sentence): the byline ROW became one of the quiet notes
    // under the question, and "runs as you" is already the agency note there, so
    // only the venue phrase itself rides along. This line used to pin the app id
    // INTO the byline (`· app_1`) — still the point, still asserted.
    const view = render(<VendoProvider client={client}><ApprovalCard approval={approval} onDecide={() => undefined} /></VendoProvider>);
    const sub = () => document.querySelector(".fl-approval-sub")!.textContent!;
    expect(sub()).toContain("asked in an app");
    expect(screen.queryByText(/app_1/)).toBeNull();
    view.rerender(<VendoProvider client={client}><ApprovalCard approval={approval} onDecide={() => undefined} showContext={false} /></VendoProvider>);
    expect(sub()).not.toContain("asked in an app");
  });
});

describe("Vendo's own tools never read as their identifiers (§3)", () => {
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

  const appsEdit = {
    type: "dynamic-tool" as const,
    toolName: "vendo_make",
    toolCallId: "call_apps",
    state: "input-available" as const,
    input: { app: "app_1", request: "make it blue" },
  };

  it("narrates the live beat with a title — never 'Vendo apps edit…'", () => {
    // The exact string wave-1 live proof E1-5 photographed. This surface holds no
    // descriptor: the wire tool part carries a name and nothing else.
    render(
      <VendoProvider client={client}>
        <BuildBeat part={appsEdit as never} risk="write" />
      </VendoProvider>,
    );
    const beat = document.querySelector(".fl-beat");
    expect(beat?.textContent).toContain("Make you a screen");
    expect(beat?.textContent).not.toMatch(/vendo/i);
    // The raw name stays as the machine affordance, exactly as for host tools.
    expect(beat?.getAttribute("data-vendo-tool")).toBe("vendo_make");
    // M32 — and never as a tooltip, where it is both hoverable and read out.
    expect(beat?.hasAttribute("title")).toBe(false);
  });

  it("M32 — a beat carries the slug for machines only, never in a tooltip", () => {
    render(
      <VendoProvider client={client}>
        <BuildBeat part={appsEdit as never} risk="write" />
      </VendoProvider>,
    );
    const beat = document.querySelector(".fl-beat")!;
    expect(beat.getAttribute("data-vendo-tool")).toBe("vendo_make");
    expect(beat.hasAttribute("title")).toBe(false);
    // Every tooltip anywhere on the beat is free of the slug.
    for (const node of document.querySelectorAll("[title]")) {
      expect(node.getAttribute("title")).not.toContain("vendo_make");
    }
  });

  it("labels a failed beat for one of Vendo's own tools with its title too", { timeout: 20_000 }, async () => {
    const thread = threadWith([{ ...appsEdit, state: "output-error" as const, errorText: "boom" }]);
    render(
      <VendoProvider client={threadClient(client, thread)}>
        <VendoThread threadId={thread.id} />
      </VendoProvider>,
    );
    await waitFor(() => expect(document.querySelector(".fl-turn-assistant")).toBeTruthy(), { timeout: 15_000 });
    expect(screen.getByText(/Make you a screen/)).toBeTruthy();
    expect(screen.queryByText(/Vendo make/)).toBeNull();
  });
});
