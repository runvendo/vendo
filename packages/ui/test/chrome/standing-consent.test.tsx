// @vitest-environment jsdom
/**
 * The last mile of a STANDING consent (FINAL SPEC v1: "user's yes, whenever").
 *
 * A build ask outlives the tab that raised it, so the surface it lands on must
 * show it on arrival AND on every later mount; it must say what it is asking so
 * a person can weigh spending a machine; it must let them say no; and once they
 * say yes, the build's own status line has to reach them — the detached build
 * has no turn to stream into, so this surface is the whole progress channel.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApprovalRequest } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient } from "../../src/index.js";
import { VendoToasts, dismissAllVendoToasts } from "../../src/chrome/index.js";
import { createWireServer, fixtureApp } from "../wire-server.js";

afterEach(() => {
  cleanup();
  act(() => dismissAllVendoToasts());
});

const BUILD_APP = "app_qr";
const PROMPT = "A page with a scannable QR code";

/** The ask the build door parks: `guard.check` on the build descriptor, with the
 *  app id and the person's own words as its inputs (build-door.ts). */
function buildAsk(base: ApprovalRequest): ApprovalRequest {
  // The base is the `host_email_send` fixture, and its `inputPreview` is that
  // ask's — "to a@example.com" on an app-build card contradicts the card's own
  // words. Rewritten the way the real guard writes it: `<tool> <canonical args>`.
  const call = { id: `call_build_${BUILD_APP}`, tool: "vendo_app_build", args: { appId: BUILD_APP, prompt: PROMPT } };
  return {
    ...base,
    id: "apr_build",
    inputPreview: `${call.tool} ${JSON.stringify(call.args)}`,
    call,
    descriptor: {
      name: "vendo_app_build",
      title: "Build this app for real",
      description: "Build this app for real: a sandbox installs the packages it needs.",
      inputSchema: {
        type: "object",
        properties: { appId: { type: "string" }, prompt: { type: "string" } },
        required: ["appId", "prompt"],
      },
      risk: "write",
      confirmEach: true,
    },
  };
}

describe("a standing ask survives the tab it was raised in", () => {
  it("surfaces an approval that was ALREADY pending at mount", async () => {
    const wire = await createWireServer();
    // The reload: the ask is on the wire before anything renders.
    wire.state.approvals.push(buildAsk(wire.state.approvals[0]!));
    const client = createVendoClient({ baseUrl: wire.url });
    render(<VendoProvider client={client}><VendoToasts approvals pollMs={40} /></VendoProvider>);

    await screen.findByText(/Build this app for real/);
    expect(screen.getAllByRole("button", { name: "Approve" }).length).toBeGreaterThan(0);
    await wire.close();
  });
});

describe("the card says what it is asking, and takes no for an answer", () => {
  it("carries the ask's own words — the person's request, not just a tool label", async () => {
    const wire = await createWireServer();
    wire.state.approvals.push(buildAsk(wire.state.approvals[0]!));
    const client = createVendoClient({ baseUrl: wire.url });
    render(<VendoProvider client={client}><VendoToasts approvals pollMs={40} /></VendoProvider>);

    await screen.findByText(/Build this app for real/);
    expect(screen.getByText(new RegExp(PROMPT))).toBeTruthy();
    await wire.close();
  });

  it("offers Deny, and a denial is what reaches the wire", async () => {
    const wire = await createWireServer();
    wire.state.approvals.push(buildAsk(wire.state.approvals[0]!));
    const client = createVendoClient({ baseUrl: wire.url });
    render(<VendoProvider client={client}><VendoToasts approvals pollMs={40} /></VendoProvider>);

    await screen.findByText(/Build this app for real/);
    const cards = document.querySelectorAll(".fl-toasts-card");
    const card = [...cards].find(item => item.textContent?.includes("Build this app for real"))!;
    const deny = [...card.querySelectorAll("button")].find(button => button.textContent === "Deny")!;
    expect(deny).toBeTruthy();
    fireEvent.click(deny);

    await waitFor(() => expect(wire.state.approvalResolutions.get("apr_build")).toEqual({ state: "declined" }));
    await waitFor(() => expect(screen.queryByText(/Build this app for real/)).toBeNull());
    await wire.close();
  });
});

describe("progress reaches the person who said yes", () => {
  it("shows the build's own status line once the yes lands, and drops it when the app does", async () => {
    const wire = await createWireServer();
    wire.state.approvals.push(buildAsk(wire.state.approvals[0]!));
    // A building app: the row exists, and its flagged opens answer the build
    // window's pending envelope carrying the lane's latest line.
    wire.state.apps.push(fixtureApp(BUILD_APP, "QR code page"));
    wire.state.pendingScreens.set(BUILD_APP, 3);
    wire.state.buildStatus.set(BUILD_APP, "Starting a build machine…");
    const client = createVendoClient({ baseUrl: wire.url });
    render(<VendoProvider client={client}><VendoToasts approvals pollMs={40} /></VendoProvider>);

    await screen.findByText(/Build this app for real/);
    const cards = document.querySelectorAll(".fl-toasts-card");
    const card = [...cards].find(item => item.textContent?.includes("Build this app for real"))!;
    const approve = [...card.querySelectorAll("button")].find(button => button.textContent === "Approve")!;
    fireEvent.click(approve);

    await screen.findByText("Starting a build machine…");
    // The app lands (pendingScreens runs out) and the progress line stands down.
    await waitFor(() => expect(screen.queryByText("Starting a build machine…")).toBeNull(), { timeout: 10_000 });
    await wire.close();
  }, 20_000);
});
