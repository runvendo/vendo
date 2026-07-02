import { describe, it, expect } from "vitest";
import type { RegisteredComponent, UINode } from "@flowlet/core";
import { stampHostComponents, diffHostComponents, NO_DRIFT } from "./component-drift";

const registered = (name: string, version?: string): RegisteredComponent => ({
  name,
  description: "x",
  propsSchema: { "~standard": { version: 1, vendor: "test", validate: (v: unknown) => ({ value: v }) } } as RegisteredComponent["propsSchema"],
  source: "host",
  ...(version !== undefined ? { version } : {}),
});

const generatedNode = (nodes: Array<{ id: string; component: string; source?: string }>): UINode => ({
  id: "v1",
  kind: "generated",
  payload: { formatVersion: "flowlet-genui/v1", root: nodes[0]!.id, nodes },
} as UINode);

describe("stampHostComponents", () => {
  it("records name → registry version for every host node in the tree", () => {
    const node = generatedNode([
      { id: "r", component: "Stack" },
      { id: "a", component: "AcmeBadge", source: "host" },
      { id: "b", component: "AcmeMeter", source: "host" },
    ]);
    const stamp = stampHostComponents(node, [registered("AcmeBadge", "2"), registered("AcmeMeter")]);
    expect(stamp).toEqual({ AcmeBadge: "2", AcmeMeter: "1" });
  });

  it("returns undefined when the tree has no host nodes (records stay stamp-free)", () => {
    const node = generatedNode([{ id: "r", component: "Stack" }]);
    expect(stampHostComponents(node, [registered("AcmeBadge")])).toBeUndefined();
  });

  it("returns undefined for non-generated nodes", () => {
    const component: UINode = { id: "c", kind: "component", source: "prewired", name: "Text", props: {} };
    expect(stampHostComponents(component, [])).toBeUndefined();
  });
});

describe("diffHostComponents", () => {
  it("is clean when every stamped component still exists at the same version", () => {
    expect(diffHostComponents({ AcmeBadge: "2" }, [registered("AcmeBadge", "2")])).toBe(NO_DRIFT);
  });

  it("reports a renamed/removed component as missing", () => {
    const drift = diffHostComponents({ AcmeOld: "1" }, [registered("AcmeNew")]);
    expect(drift).toEqual({ missing: ["AcmeOld"], changed: [] });
  });

  it("reports a version bump as changed", () => {
    const drift = diffHostComponents({ AcmeBadge: "1" }, [registered("AcmeBadge", "2")]);
    expect(drift).toEqual({ missing: [], changed: ["AcmeBadge"] });
  });

  it("treats an unset registry version as '1'", () => {
    expect(diffHostComponents({ AcmeBadge: "1" }, [registered("AcmeBadge")])).toBe(NO_DRIFT);
  });

  it("diffs a stamp-free (pre-versioning) record as clean — no retroactive warnings", () => {
    expect(diffHostComponents(undefined, [registered("AcmeBadge", "9")])).toBe(NO_DRIFT);
  });
});
