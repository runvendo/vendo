// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { VendoAppRef, VendoApprovalRef } from "@vendoai/core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VendoAppEmbed,
  VendoApprovalEmbed,
  VendoProvider,
  VendoToolResult,
  createVendoClient,
  type VendoClient,
} from "../src/index.js";
import { createWireServer } from "./wire-server.js";

// Existing-agents Lane B — the three embeds a BYO chat surface renders from
// `vendo_*` tool outputs, inside the same VendoProvider the headless hooks
// use. The wire owns approval state; the embed renders it in place with the
// existing failed/expired vocabulary — never a silent blank.

const appRef: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_1", title: "Invoices" };
const approvalRef: VendoApprovalRef = {
  kind: "vendo/approval-ref@1",
  approvalId: "apr_1",
  summary: "Send the report to a client",
};

describe("existing-agents embeds", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    // Unmount BEFORE closing the wire. Testing-library's automatic cleanup
    // runs in its own, later hook — so without this, a still-mounted
    // VendoAppEmbed whose app never became servable keeps polling open()
    // into the closing server every APP_POLL_MS, the socket never goes
    // idle, and server.close() livelocks until the hook timeout (the CI
    // "Hook timed out" flake; local runs won the race by luck).
    cleanup();
    await wire.close();
  });

  function mount(children: ReactNode) {
    return render(<VendoProvider client={client}>{children}</VendoProvider>);
  }

  describe("VendoToolResult", () => {
    it("renders nothing for plain data — the action executed cleanly", () => {
      const { container } = mount(<VendoToolResult output={{ delivered: true }} />);
      expect(container.querySelector("[data-vendo-embed]")).toBeNull();
    });

    it("renders nothing for a malformed envelope rather than half-rendering it", () => {
      const { container } = mount(
        <VendoToolResult output={{ kind: "vendo/app-ref@1", appId: 42 }} />,
      );
      expect(container.querySelector("[data-vendo-embed]")).toBeNull();
    });

    it("dispatches an app-ref envelope to the app embed", async () => {
      const { container } = mount(<VendoToolResult output={appRef} />);
      expect(container.querySelector('[data-vendo-embed="app"]')).not.toBeNull();
      await waitFor(() => expect(screen.getByText("Invoices app surface")).toBeDefined());
    });

    it("dispatches an approval-ref envelope to the approval embed", async () => {
      const { container } = mount(<VendoToolResult output={approvalRef} />);
      expect(container.querySelector('[data-vendo-embed="approval"]')).not.toBeNull();
      await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeDefined());
    });
  });

  describe("VendoApprovalEmbed", () => {
    it("renders the consent card with real inputs while pending, then resolves in place to the executed outcome on approve", async () => {
      mount(<VendoApprovalEmbed refValue={approvalRef} />);

      // The pending request feeds the existing ApprovalCard machinery.
      const approve = await screen.findByRole("button", { name: "Approve" });
      expect(screen.getByText("a@example.com")).toBeDefined();

      fireEvent.click(approve);

      // The wire executes the parked call; the embed resolves in place.
      await waitFor(() => expect(screen.getByText("Approved — ran")).toBeDefined());
      expect(wire.requests).toContainEqual(
        expect.objectContaining({
          method: "POST",
          path: "/approvals/decide",
          body: { ids: ["apr_1"], decision: { approve: true } },
        }),
      );
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    });

    it("resolves to declined on deny and never renders the outcome", async () => {
      mount(<VendoApprovalEmbed refValue={approvalRef} />);
      fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
      await waitFor(() => expect(screen.getByText(/declined/i)).toBeDefined());
    });

    it("renders the executed outcome's failure with the failed vocabulary, not a blank", async () => {
      wire.state.approvals = [];
      wire.state.approvalResolutions.set("apr_1", {
        state: "executed",
        outcome: { status: "error", error: { code: "error", message: "downstream exploded" } },
      });
      mount(<VendoApprovalEmbed refValue={approvalRef} />);
      await waitFor(() => expect(screen.getByText(/couldn't finish/i)).toBeDefined());
      expect(screen.getByText(/downstream exploded/)).toBeDefined();
    });

    it("renders expired for a TTL-swept approval", async () => {
      wire.state.approvals = [];
      wire.state.approvalResolutions.set("apr_1", { state: "expired" });
      mount(<VendoApprovalEmbed refValue={approvalRef} />);
      await waitFor(() => expect(screen.getByText(/expired/i)).toBeDefined());
    });

    it("renders expired for an approval the wire no longer knows", async () => {
      wire.state.approvals = [];
      mount(<VendoApprovalEmbed refValue={approvalRef} />);
      await waitFor(() => expect(screen.getByText(/expired/i)).toBeDefined());
    });

    it("surfaces a wire failure as an alert, never a silent blank", async () => {
      wire.state.failures.push({
        method: "GET",
        path: "/approvals/apr_1",
        code: "not-implemented",
        message: "wire down",
        status: 501,
      });
      mount(<VendoApprovalEmbed refValue={approvalRef} />);
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("wire down"));
    });
  });

  describe("VendoAppEmbed", () => {
    it("renders the live app surface once the wire serves it, under the ref's title chrome", async () => {
      mount(<VendoAppEmbed refValue={appRef} />);
      await waitFor(() => expect(screen.getByText("Invoices app surface")).toBeDefined());
      expect(screen.getByText("Invoices")).toBeDefined();
    });

    it("shows the build beat while the app is not yet servable", async () => {
      const building: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_building", title: "Weather board" };
      mount(<VendoAppEmbed refValue={building} />);
      await waitFor(() => expect(screen.getByText(/Building/)).toBeDefined());
      expect(screen.getByText("Weather board")).toBeDefined();
    });

    it("polls the build window under the pending flag, so a miss is a 200 envelope and never a console 404", async () => {
      const building: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_building", title: "Weather board" };
      mount(<VendoAppEmbed refValue={building} />);
      await waitFor(() => {
        const polls = wire.requests.filter(item => item.path.startsWith("/apps/app_building/open"));
        expect(polls.length).toBeGreaterThan(0);
        for (const poll of polls) expect(poll.path).toBe("/apps/app_building/open?pending=1");
      });
      // Still honestly building — the pending envelope resolves nothing.
      expect(screen.getByText(/Building/)).toBeDefined();
    });

    it("resolves the failed vocabulary WITH the reason promptly when the build terminally fails (#492)", async () => {
      const doomed: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_doomed", title: "Budget tracker" };
      // The build turn threw server-side: open() now answers {kind:"failed"}
      // instead of an eternal pending, so the embed resolves on the FIRST poll
      // rather than waiting for APP_BUILD_DEADLINE_MS.
      wire.state.failedApps.set("app_doomed", { reason: "quota exhausted", retryable: false });
      mount(<VendoAppEmbed refValue={doomed} />);
      await waitFor(() => expect(screen.getByText(/couldn't finish/i)).toBeDefined());
      // The honest reason is shown, not just the generic failed beat.
      expect(screen.getByText("quota exhausted")).toBeDefined();
      // A non-retryable failure carries no retry hint.
      expect(screen.queryByText(/Retryable/)).toBeNull();
      // Resolved terminally — no skeletons still building.
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("shows the retry hint when the terminal failure is retryable", async () => {
      const doomed: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_retry", title: "Retry tracker" };
      wire.state.failedApps.set("app_retry", { reason: "generation failed", retryable: true });
      mount(<VendoAppEmbed refValue={doomed} />);
      await waitFor(() => expect(screen.getByText(/couldn't finish/i)).toBeDefined());
      expect(screen.getByText("generation failed")).toBeDefined();
      expect(screen.getByText(/Retryable — ask for the app again/)).toBeDefined();
    });

    it("resolves the build beat into the app when the build lands mid-poll", async () => {
      const late: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_late", title: "Late app" };
      mount(<VendoAppEmbed refValue={late} />);
      await waitFor(() => expect(screen.getByText(/Building/)).toBeDefined());
      // The build lands: the app becomes servable on a later poll.
      wire.state.apps.push({
        format: "vendo/app@1",
        id: "app_late",
        name: "Late app",
        ui: "tree",
        tree: {
          formatVersion: "vendo-genui/v2",
          root: "root",
          nodes: [{ id: "root", component: "Text", props: { text: "Late app surface" } }],
        },
      });
      await waitFor(() => expect(screen.getByText("Late app surface")).toBeDefined(), { timeout: 5000 });
    });
  });
});
