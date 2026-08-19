// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { VendoApprovalRef } from "@vendoai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VendoApprovalEmbed,
  VendoProvider,
  createVendoClient,
  type VendoClient,
} from "../src/index.js";
import { createWireServer } from "./wire-server.js";

// What a settled receipt says about the data the resumed call handed BACK.
// The rows come off the one body the ask itself uses (spec §16 law 1), and that
// body names a value with no name of its own after the side it was written for:
// "Input". On the way back that is the wrong direction — a returned todo list
// read as the input the person had approved sending.

const approvalRef: VendoApprovalRef = {
  kind: "vendo/approval-ref@1",
  approvalId: "apr_1",
  summary: "Email the June statement",
};

describe("the settled receipt's result rows", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
    // Nothing pending: this file is about the receipt, so the wire answers the
    // executed resolution the umbrella's park→resume writes.
    wire.state.approvals = [];
  });

  afterEach(async () => {
    cleanup();
    await wire.close();
  });

  /** The real read path: the embed polls the wire for apr_1 and settles. */
  async function receipt(output: unknown): Promise<string[][]> {
    wire.state.approvalResolutions.set("apr_1", {
      state: "executed",
      outcome: { status: "ok", output: output as never },
    });
    render(
      <VendoProvider client={client}>
        <VendoApprovalEmbed refValue={approvalRef} />
      </VendoProvider>,
    );
    await waitFor(() => expect(screen.getByText("Approved — ran")).toBeDefined());
    return Array.from(document.querySelectorAll(".fl-card-field")).map(field => [
      field.querySelector("dt")!.textContent!,
      field.querySelector("dd")!.textContent!,
    ]);
  }

  it("labels a returned list by its direction — the row is the result, never the call's input", async () => {
    expect(await receipt(["Buy milk", "Ship the release"])).toEqual([
      ["Result", "Buy milk\nShip the release"],
    ]);
    expect(document.body.textContent).not.toContain("Input");
  });

  it("shows a bare returned value at all — the object-only guard showed a person nothing", async () => {
    expect(await receipt("3 todos are open")).toEqual([["Result", "3 todos are open"]]);
  });

  it("keeps a named result's own field names, humanized as everywhere else", async () => {
    expect(await receipt({ delivered: true })).toEqual([["Delivered", "Yes"]]);
  });

  it("adds no body at all for a call that returned nothing", async () => {
    expect(await receipt(null)).toEqual([]);
  });
});
