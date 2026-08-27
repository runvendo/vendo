import { parseVendoToolEnvelope, type VendoAppRef, type VendoApprovalRef } from "@vendoai/core";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  isVendoToolPart,
  type VendoAppEmbedProps,
  type VendoApprovalEmbedProps,
  type VendoApprovalEmbedState,
  type VendoToolResultProps,
} from "../src/index.js";

// Wave 0 contract freeze — the embed prop shapes Lane B builds the three
// components behind. Types only today; these assignments are the compile-time
// assertion that the frozen shapes stay importable from the package root.

describe("embed prop contracts", () => {
  it("VendoAppEmbed takes the app-ref envelope verbatim", () => {
    const refValue: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_x", title: "Dashboard", status: "building" };
    const props: VendoAppEmbedProps = { refValue };
    expect(props.refValue.appId).toBe("app_x");
  });

  it("VendoApprovalEmbed takes the approval-ref envelope and resolves through the frozen state vocabulary", () => {
    const refValue: VendoApprovalRef = {
      kind: "vendo/approval-ref@1",
      approvalId: "apr_x",
      summary: "Send the report",
    };
    const props: VendoApprovalEmbedProps = { refValue };
    const states: VendoApprovalEmbedState[] = ["pending", "executed", "declined", "expired"];
    expect(props.refValue.approvalId).toBe("apr_x");
    expect(states).toHaveLength(4);
  });

  /** The provider went optional by DEFAULTING, not by growing a knob: these
   *  exhaustive (and excess-checked) key maps fail to compile the day a
   *  client/baseUrl prop appears on any of the three.
   *
   *  `theme` is the one deliberate addition (approved 2026-08-23, per-surface
   *  theme overrides). It is not a second way to reach the wire — it is the
   *  chrome's own tokens, optional, and it never widens what an embed can talk
   *  to. Everything else on this list stays banned. */
  it("takes no client or config prop of its own, bare or not", () => {
    const appKeys: Record<keyof VendoAppEmbedProps, true> = { refValue: true, theme: true };
    const approvalKeys: Record<keyof VendoApprovalEmbedProps, true> = { refValue: true, theme: true };
    const resultKeys: Record<keyof VendoToolResultProps, true> = { output: true, theme: true };
    expect([Object.keys(appKeys), Object.keys(approvalKeys), Object.keys(resultKeys)])
      .toEqual([["refValue", "theme"], ["refValue", "theme"], ["output", "theme"]]);
  });

  /** The prop stays OPTIONAL: an embed still works with nothing but its ref. */
  it("theme is optional on all three", () => {
    const app: VendoAppEmbedProps = {
      refValue: { kind: "vendo/app-ref@1", appId: "app_x", title: "Dashboard", status: "building" },
    };
    const approval: VendoApprovalEmbedProps = {
      refValue: { kind: "vendo/approval-ref@1", approvalId: "apr_x", summary: "Send the report" },
    };
    const result: VendoToolResultProps = { output: null };
    expect([app.theme, approval.theme, result.theme]).toEqual([undefined, undefined, undefined]);
  });

  /** A PARTIAL is enough — the same `Partial<VendoTheme>` the provider takes,
   *  so a surface changing only the density says only that. */
  it("theme takes a partial theme, group by group", () => {
    const props: VendoToolResultProps = { output: null, theme: { density: "compact" } };
    expect(props.theme?.density).toBe("compact");
  });

  it("VendoToolResult takes any vendo_* tool output and dispatches on the envelope parse", () => {
    const props: VendoToolResultProps = { output: { delivered: true } };
    expect(parseVendoToolEnvelope(props.output)).toBeNull();
    const appProps: VendoToolResultProps = {
      output: { kind: "vendo/app-ref@1", appId: "app_x", title: "Dashboard", status: "building" },
    };
    expect(parseVendoToolEnvelope(appProps.output)?.kind).toBe("vendo/app-ref@1");
  });
});

/** The branch a host's own message-part renderer takes before it reaches
 *  <VendoToolResult>: it owns the whole "is this Vendo's" question, so nobody
 *  outside this package has to know the `vendo_` prefix is the contract. */
describe("isVendoToolPart", () => {
  type Part = UIMessage["parts"][number];

  const vendoPart: Part = {
    type: "dynamic-tool",
    toolName: "vendo_make",
    toolCallId: "call_1",
    state: "output-available",
    input: {},
    output: { kind: "vendo/app-ref@1", appId: "app_x", title: "Dashboard", status: "building" },
  };

  it("claims a vendo_-prefixed dynamic tool", () => {
    expect(isVendoToolPart(vendoPart)).toBe(true);
  });

  it("claims a vendo_-prefixed tool-<name> part — both streamed shapes, one branch", () => {
    const part: Part = {
      type: "tool-vendo_make",
      toolCallId: "call_2",
      state: "output-available",
      input: {},
      output: { kind: "vendo/app-ref@1", appId: "app_y", title: "Invoices", status: "building" },
    };
    expect(isVendoToolPart(part)).toBe(true);
  });

  it("leaves the host's own tools alone, in either shape", () => {
    const hostDynamic: Part = {
      type: "dynamic-tool",
      toolName: "send_invoice",
      toolCallId: "call_3",
      state: "output-available",
      input: {},
      output: { delivered: true },
    };
    const hostStatic: Part = {
      type: "tool-send_invoice",
      toolCallId: "call_4",
      state: "output-available",
      input: {},
      output: { delivered: true },
    };
    expect([isVendoToolPart(hostDynamic), isVendoToolPart(hostStatic)]).toEqual([false, false]);
  });

  it("leaves parts that are not tool calls alone", () => {
    const text: Part = { type: "text", text: "vendo_make" };
    expect(isVendoToolPart(text)).toBe(false);
  });

  /** The deliberate contract: it answers "is this Vendo's", never "is it
   *  finished". A predicate that also meant finished would leave a host no way
   *  to tell an unfinished Vendo part from one of its own — which is exactly
   *  what the Mastra page's "Running…" branch needs. */
  it("claims an unfinished vendo_ part too — state stays the host's own check", () => {
    const streaming: Part = {
      type: "dynamic-tool",
      toolName: "vendo_make",
      toolCallId: "call_5",
      state: "input-streaming",
      input: undefined,
    };
    expect(isVendoToolPart(streaming)).toBe(true);
  });

  it("narrows, so output and state read with no cast", () => {
    const part: Part = vendoPart;
    if (!isVendoToolPart(part)) throw new Error("expected a Vendo tool part");
    // Nothing below is asserted or cast — that these two lines COMPILE is the
    // test. Without the type predicate, both are errors on a UIMessagePart.
    const output: unknown = part.output;
    const state: string = part.state;
    expect(parseVendoToolEnvelope(output)?.kind).toBe("vendo/app-ref@1");
    expect(state).toBe("output-available");
  });
});
