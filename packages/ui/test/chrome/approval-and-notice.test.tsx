// @vitest-environment jsdom
import type { ApprovalRequest } from "@vendoai/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import {
  ActivityPanel,
  ApprovalCard,
  AutomationsPanel,
  ChromeRoot,
  NoPolicyNotice,
  VendoOverlay,
  VendoPage,
  VendoPalette,
  VendoSlot,
  VendoStage,
  VendoThread,
  WaitingQueue,
} from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

const approval: ApprovalRequest = {
  id: "apr_real",
  call: { id: "call_real", tool: "host_delete_invoice", args: { invoiceId: "inv_42", permanent: true } },
  descriptor: { name: "host_delete_invoice", description: "Delete invoice", inputSchema: {}, risk: "destructive" },
  inputPreview: "invoiceId=inv_42\npermanent=true",
  ctx: { principal: { kind: "user", subject: "user_1" }, venue: "app", presence: "present", appId: "app_1" },
  createdAt: "2026-07-11T12:00:00.000Z",
};

describe("ApprovalCard and NoPolicyNotice exports", () => {
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

  it("shows the real inputs as fields and emits basic approve and deny decisions", async () => {
    const onDecide = vi.fn();
    render(<VendoProvider client={client}><ApprovalCard approval={approval} onDecide={onDecide} /></VendoProvider>);
    // Flat args render as aligned key→value rows — labels prettified for
    // reading, values verbatim unless the host formats them (then the raw
    // value rides the dd tooltip — the consent honesty contract).
    const fields = screen.getByLabelText("Real tool inputs");
    const rows = [...fields.querySelectorAll(".fl-approval-field")].map(row => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent,
    ]);
    // A boolean is an answer, not a literal (this line used to pin "true").
    expect(rows).toEqual([["Invoice id", "inv_42"], ["Permanent", "Yes"]]);
    // The risk chip speaks the user's language; the data attr keeps the slug.
    expect(screen.getByText("Irreversible").getAttribute("data-risk")).toBe("destructive");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenNthCalledWith(1, { approve: true });
    expect(onDecide).toHaveBeenNthCalledWith(2, { approve: false });
  });

  it("shows descriptor drift provenance only when a previous grant was invalidated", () => {
    const grantedAt = "2026-07-01T12:00:00.000Z";
    const expected = "This tool changed since you approved it on Jul 1, 2026 — your previous permission no longer applies.";
    const view = render(
      <VendoProvider client={client}>
        <ApprovalCard
          approval={{
            ...approval,
            invalidatedGrant: { id: "grt_stale", grantedAt },
          }}
          onDecide={() => undefined}
        />
      </VendoProvider>,
    );

    expect(screen.getByRole("note", { name: "Previous permission invalidated" }).textContent).toBe(expected);

    view.rerender(
      <VendoProvider client={client}>
        <ApprovalCard approval={approval} onDecide={() => undefined} />
      </VendoProvider>,
    );
    expect(screen.queryByRole("note", { name: "Previous permission invalidated" })).toBeNull();
  });

  it("mints exact/session and whole-tool/standing remember shapes", async () => {
    const onDecide = vi.fn();
    render(<VendoProvider client={client}><ApprovalCard approval={approval} onDecide={onDecide} /></VendoProvider>);
    fireEvent.click(screen.getByText("Remember this decision"));
    fireEvent.click(screen.getByLabelText("Create a reusable grant when approved"));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onDecide).toHaveBeenLastCalledWith({
      approve: true,
      remember: {
        scope: expect.objectContaining({ kind: "exact", inputHash: expect.stringMatching(/^sha256:/), inputPreview: approval.inputPreview }),
        duration: "session",
      },
    });
    await waitFor(() => expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByLabelText("The whole tool"));
    fireEvent.click(screen.getByLabelText("Standing"));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onDecide).toHaveBeenLastCalledWith({ approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } });
  });

  it("injects the chrome stylesheet once and applies resolved theme variables", () => {
    render(
      <VendoProvider client={client} theme={{ colors: { accent: "rgb(1, 2, 3)" } }}>
        <ApprovalCard approval={approval} onDecide={() => undefined} />
        <ApprovalCard approval={{ ...approval, id: "apr_2" }} onDecide={() => undefined} />
      </VendoProvider>,
    );
    expect(document.querySelectorAll("style[data-vendo-chrome]")).toHaveLength(1);
    expect((document.querySelector(".vendo-root") as HTMLElement).style.getPropertyValue("--vendo-color-accent")).toBe("rgb(1, 2, 3)");
  });

  it("is hidden for rules posture and loud for unconfigured posture", async () => {
    const view = render(<VendoProvider client={client}><NoPolicyNotice /></VendoProvider>);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Vendo is running without a policy" })).toBeNull());

    wire.state.posture = "unconfigured";
    const refreshed = createVendoClient({ baseUrl: wire.url });
    view.rerender(<VendoProvider client={refreshed}><NoPolicyNotice /></VendoProvider>);
    const region = await screen.findByRole("region", { name: "Vendo is running without a policy" });
    expect(region.textContent).toContain(".vendo/policy.json");
  });

  it("stays silent while the wire is unreachable — unknown posture is not 'unconfigured'", async () => {
    await wire.close();
    const unreachable = createVendoClient({ baseUrl: "http://127.0.0.1:9/api/vendo" });
    render(<VendoProvider client={unreachable}><NoPolicyNotice /></VendoProvider>);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Vendo is running without a policy" })).toBeNull());
  });

  it("renders the developer banner on NO end-user surface, even under unconfigured posture", async () => {
    // C1 — the banner names a file to configure, so it may never ride a surface
    // a PERSON reaches. It used to arrive automatically inside every chrome
    // boundary (ChromeRoot's default was `true`): the thread, the overlay, a
    // pinned slot, an embed, the voice stage, the share dialog. Now it is opt-in.
    wire.state.posture = "unconfigured";
    const surfaces: React.ReactNode[] = [
      <VendoThread threadId="thr_1" />,
      <VendoOverlay open />,
      <VendoSlot appId="app_1" />,
      <VendoStage />,
      <ApprovalCard approval={approval} onDecide={() => undefined} />,
      <WaitingQueue pollMs={0} />,
      <ActivityPanel />,
    ];
    for (const surface of surfaces) {
      // The host's OWN explicit banner rides alongside: it renders only on a
      // known-unconfigured posture, so its presence proves the probe answered —
      // and the count proves the surface beside it contributed none of its own.
      render(<VendoProvider client={client}><NoPolicyNotice />{surface}</VendoProvider>);
      await screen.findByRole("region", { name: "Vendo is running without a policy" });
      expect(screen.getAllByRole("region", { name: "Vendo is running without a policy" })).toHaveLength(1);
      cleanup();
    }
  });

  it("still renders the banner for a surface that explicitly opts in", async () => {
    wire.state.posture = "unconfigured";
    render(
      <VendoProvider client={client}>
        <ChromeRoot automaticPolicyNotice>developer console</ChromeRoot>
      </VendoProvider>,
    );
    expect(await screen.findByRole("region", { name: "Vendo is running without a policy" })).toBeTruthy();
  });

  // ⚠️ These three used to pin the AUTOMATIC banner (C1's defect): they asserted
  // that ActivityPanel / AutomationsPanel / VendoStage / VendoPage each grew the
  // developer banner on their own, which is the same code path that put it on a
  // customer's thread, slot, embed and voice stage. They now pin the guarantee
  // instead — no chrome surface renders it, the host's explicit mount does.
  it("no workspace surface grows the banner on its own — the host's mount is the one source", async () => {
    wire.state.posture = "unconfigured";
    const surfaces = [<ActivityPanel />, <AutomationsPanel />, <VendoStage />];

    for (const surface of surfaces) {
      render(<VendoProvider client={client}><NoPolicyNotice />{surface}</VendoProvider>);
      await screen.findByRole("region", { name: "Vendo is running without a policy" });
      expect(screen.getAllByRole("region", { name: "Vendo is running without a policy" })).toHaveLength(1);
      cleanup();
    }
  });

  it("renders exactly one notice beside a page full of nested chrome roots", async () => {
    wire.state.posture = "unconfigured";
    render(<VendoProvider client={client}><NoPolicyNotice /><VendoPage /></VendoProvider>);
    await waitFor(() => expect(screen.getAllByRole("region", { name: "Vendo is running without a policy" })).toHaveLength(1));
  });

  it("renders no notice on any chrome surface under rules posture", async () => {
    render(
      <VendoProvider client={client}>
        <NoPolicyNotice />
        <ActivityPanel />
        <AutomationsPanel />
        <VendoPalette />
        <VendoStage />
        <VendoPage />
      </VendoProvider>,
    );
    await waitFor(() => expect(wire.requests.some(request => request.path === "/status")).toBe(true));
    expect(screen.queryByRole("region", { name: "Vendo is running without a policy" })).toBeNull();
  });
});
