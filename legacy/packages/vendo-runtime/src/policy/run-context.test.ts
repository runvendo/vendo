import { describe, expect, it } from "vitest";
import { createRunPolicyContext } from "./run-context.js";
import type { ToolDescriptor } from "../descriptor.js";

const readDesc: ToolDescriptor = { name: "get_x", source: "caller", annotations: { readOnlyHint: true }, hasExecute: true, kind: "function" };
const openWorldDesc: ToolDescriptor = { name: "GMAIL_FETCH", source: "composio", annotations: { openWorldHint: true }, hasExecute: true, kind: "function" };
const composioDesc: ToolDescriptor = { name: "SLACK_LIST", source: "composio", annotations: { readOnlyHint: true }, hasExecute: true, kind: "function" };
const unverifiedDesc: ToolDescriptor = { name: "mystery_tool", source: "caller", annotations: {}, hasExecute: true, kind: "function" };
const safeDesc: ToolDescriptor = { name: "render_view", source: "engine", annotations: { readOnlyHint: true }, hasExecute: true, kind: "function" };

describe("createRunPolicyContext", () => {
  it("carries the request through unchanged", () => {
    const rc = createRunPolicyContext({ text: "email jim", messageId: "m1" });
    expect(rc.request).toEqual({ text: "email jim", messageId: "m1" });
  });

  it("starts with empty provenance and zeroed counters", () => {
    const rc = createRunPolicyContext();
    expect(rc.snapshotProvenance()).toEqual({ taintedSources: [] });
    expect(rc.snapshotCounters()).toEqual({ toolCallsThisTurn: 0, perTool: {} });
  });

  it("recordCall tallies total and per-tool counts", () => {
    const rc = createRunPolicyContext();
    rc.recordCall("send_email");
    rc.recordCall("send_email");
    rc.recordCall("get_x");
    expect(rc.snapshotCounters()).toEqual({
      toolCallsThisTurn: 3,
      perTool: { send_email: 2, get_x: 1 },
    });
  });

  it("recordResult taints openWorld, composio-sourced, and unverified tools", () => {
    const rc = createRunPolicyContext();
    rc.recordResult("GMAIL_FETCH", openWorldDesc);
    rc.recordResult("SLACK_LIST", composioDesc);
    rc.recordResult("mystery_tool", unverifiedDesc);
    expect(rc.snapshotProvenance().taintedSources.sort()).toEqual(
      ["GMAIL_FETCH", "SLACK_LIST", "mystery_tool"].sort(),
    );
  });

  it("recordResult does NOT taint a plain safe read", () => {
    const rc = createRunPolicyContext();
    rc.recordResult("render_view", safeDesc);
    rc.recordResult("get_x", readDesc);
    expect(rc.snapshotProvenance()).toEqual({ taintedSources: [] });
  });

  it("snapshots are independent copies — mutating the returned object never leaks back", () => {
    const rc = createRunPolicyContext();
    rc.recordCall("t");
    const snap = rc.snapshotCounters();
    snap.perTool["t"] = 999;
    expect(rc.snapshotCounters().perTool["t"]).toBe(1);
  });
});
