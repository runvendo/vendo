// @vitest-environment jsdom
/**
 * Rehearse availability, driven by the server-resolved `rehearsal` outlook.
 *
 * A rehearsal costs a full round of REAL host reads, so offering it where it
 * cannot pay for itself is not merely untidy: a read-only automation replays
 * fine and reports nothing to consent to, which reads as the feature being
 * thin rather than the automation being inert. Two shapes are worth nothing
 * and are treated differently on purpose — an unsupported trigger/run shape
 * would only error, so the control goes away entirely, while a supported but
 * action-free automation keeps a visibly disabled control that says why.
 *
 * The field is additive, so its ABSENCE must keep today's always-offer
 * behaviour — an older server must not silently lose the action.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { AutomationsPanel } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

describe("Rehearse availability", () => {
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

  const renderPanel = () => render(
    <VendoProvider client={client}>
      <AutomationsPanel />
    </VendoProvider>,
  );

  const rehearse = () => screen.queryByRole("button", { name: "Rehearse" }) as HTMLButtonElement | null;

  /** The fixture automation's one (schedule) trigger row. */
  const scheduleRow = () => wire.state.automations[0]!.triggers[0]!;

  it("offers Rehearse when the automation acts", async () => {
    scheduleRow().rehearsal = {
      supported: true, actingSteps: 1, readSteps: 1, historicalReads: 1,
    };
    renderPanel();
    await waitFor(() => expect(rehearse()).not.toBeNull());
    expect(rehearse()!.disabled).toBe(false);
  });

  it("disables Rehearse when nothing would be simulated", async () => {
    scheduleRow().rehearsal = {
      supported: true, actingSteps: 0, readSteps: 2, historicalReads: 2,
    };
    renderPanel();
    // Present, so the affordance is still discoverable — but not clickable,
    // and historical reads do NOT redeem it: there is still no action.
    await waitFor(() => expect(rehearse()).not.toBeNull());
    expect(rehearse()!.disabled).toBe(true);
  });

  it("removes Rehearse entirely when the shape cannot be rehearsed", async () => {
    scheduleRow().rehearsal = {
      supported: false, actingSteps: 1, readSteps: 1, historicalReads: 0,
    };
    renderPanel();
    // Dry run still renders, so the panel itself has loaded — this is the
    // absence of one control, not an empty panel.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Dry run" })).not.toBeNull());
    expect(rehearse()).toBeNull();
  });

  it("keeps offering Rehearse when the server sends no outlook at all", async () => {
    delete scheduleRow().rehearsal;
    renderPanel();
    await waitFor(() => expect(rehearse()).not.toBeNull());
    expect(rehearse()!.disabled).toBe(false);
  });
});
