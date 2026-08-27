// @vitest-environment jsdom
/**
 * Where a build's standing ask lands — and where it does NOT.
 *
 * A build ask outlives the tab that raised it, so it has to reach the person on
 * surfaces that survive: the in-thread `ApprovalCard` the `data-vendo-approval`
 * part paints (proved end to end in packages/vendo's escalate-consent seam),
 * and the launcher badge, which is what keeps a closed thread from stranding
 * it. What it must NOT do is arrive as a toast popup over whatever the person
 * was doing — that asked the same question a second time, in a second place.
 *
 * The filter belongs to the toast surface alone. Applied to the feed all three
 * surfaces share, the badge would stop counting the ask and a closed thread
 * really would strand it, so both halves are pinned here.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ApprovalRequest } from "@vendoai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient } from "../../src/index.js";
import { VendoOverlay, VendoToasts, dismissAllVendoToasts } from "../../src/chrome/index.js";
import { markSeen } from "../../src/chrome/discoverability.js";
import { createWireServer } from "../wire-server.js";

beforeEach(() => {
  markSeen("whisper");
});

afterEach(() => {
  cleanup();
  act(() => dismissAllVendoToasts());
});

const BUILD_APP = "app_qr";
const PROMPT = "A page with a scannable QR code";

const cards = () => [...document.querySelectorAll(".fl-toasts-card")];
const badge = () => document.querySelector(".fl-launcher-badge");

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

describe("a build's ask never arrives as a toast", () => {
  it("skips the build ask while the ordinary ask beside it still toasts", async () => {
    const wire = await createWireServer();
    // Both asks are on the wire before anything renders — the reload case, the
    // one where the toast stack shows its whole backlog.
    wire.state.approvals.push(buildAsk(wire.state.approvals[0]!));
    const client = createVendoClient({ baseUrl: wire.url });
    render(<VendoProvider client={client}><VendoToasts approvals pollMs={40} /></VendoProvider>);

    // The ordinary ask is the positive control: it proves the feed reached this
    // surface, so the build's absence is a decision and not a poll that never
    // landed.
    await screen.findByText(/Waiting on you:/);
    // Several polls later it is still the only card — nothing re-raises the
    // build on a later tick.
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.textContent).not.toContain("Build this app for real");
    await wire.close();
  });

  it("still counts on the launcher badge, so a closed thread cannot strand it", async () => {
    const wire = await createWireServer();
    wire.state.approvals.push(buildAsk(wire.state.approvals[0]!));
    const client = createVendoClient({ baseUrl: wire.url });
    render(
      <VendoProvider client={client}>
        {/* The badge rides the launcher pill, which is opt-in, so this
            surface asks for it. */}
        <VendoOverlay launcher={{}} />
        <VendoToasts approvals pollMs={40} />
      </VendoProvider>,
    );

    // Two asks waiting, two on the badge, one toast.
    await waitFor(() => expect(badge()?.textContent).toBe("2"));
    expect(cards()).toHaveLength(1);
    await wire.close();
  });
});
