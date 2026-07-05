import { describe, it, expect } from "vitest";
import { z } from "zod";
import { hostPropIssues } from "./host-props";
import type { GeneratedPayload } from "./format";
import type { RegisteredComponent, VendoSchema } from "../index";

const badge = (schema: z.ZodType): RegisteredComponent => ({
  name: "AcmeBadge",
  description: "status pill",
  propsSchema: schema as VendoSchema<unknown>,
  source: "host",
});

const stringTitle = z.object({ text: z.string(), variant: z.enum(["ok", "warn"]).optional() });

const payloadWith = (
  props: Record<string, unknown>,
  data?: Record<string, unknown>,
  component = "AcmeBadge",
): GeneratedPayload => ({
  formatVersion: "vendo-genui/v1",
  root: "r",
  nodes: [
    { id: "r", component: "Stack", children: ["b"] },
    { id: "b", component, source: "host", props },
  ],
  ...(data ? { data } : {}),
});

describe("hostPropIssues", () => {
  it("returns no issues for schema-conforming literal props", () => {
    expect(hostPropIssues(payloadWith({ text: "Paid", variant: "ok" }), [badge(stringTitle)])).toEqual([]);
  });

  it("flags schema-invalid props with the node id and a repair-ready message", () => {
    const issues = hostPropIssues(payloadWith({ text: 42 }), [badge(stringTitle)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ nodeId: "b", component: "AcmeBadge", kind: "invalid-props" });
    expect(issues[0]!.message).toMatch(/text/);
  });

  it("flags a non-allowed enum value", () => {
    const issues = hostPropIssues(payloadWith({ text: "Paid", variant: "on-fire" }), [badge(stringTitle)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("invalid-props");
  });

  it("flags an unknown host component name, listing what IS registered", () => {
    const issues = hostPropIssues(payloadWith({ text: "x" }, undefined, "AcmeTypo"), [badge(stringTitle)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ nodeId: "b", component: "AcmeTypo", kind: "unknown-component" });
    expect(issues[0]!.message).toContain("AcmeBadge");
  });

  it("resolves $path bindings against data before validating", () => {
    const ok = hostPropIssues(payloadWith({ text: { $path: "/label" } }, { label: "Paid" }), [badge(stringTitle)]);
    expect(ok).toEqual([]);
    const bad = hostPropIssues(payloadWith({ text: { $path: "/label" } }, { label: 42 }), [badge(stringTitle)]);
    expect(bad).toHaveLength(1);
  });

  it("skips schema validation (but not the unknown check) when a prop is $state-bound", () => {
    // $state resolves client-side; the server cannot know the value, so a
    // false rejection here would block legitimate views.
    const issues = hostPropIssues(payloadWith({ text: { $state: "sel" } }), [badge(stringTitle)]);
    expect(issues).toEqual([]);
  });

  it("skips async schemas (v1 mirrors the stage's sync-only rule)", () => {
    // The refine always rejects, but only asynchronously — a Promise from
    // validate means skip, so no issue is reported.
    const asyncSchema = z.object({ text: z.string() }).refine(async () => false);
    const issues = hostPropIssues(payloadWith({ text: "ok" }), [badge(asyncSchema)]);
    expect(issues).toEqual([]);
  });

  it("ignores prewired and generated nodes entirely", () => {
    const payload: GeneratedPayload = {
      formatVersion: "vendo-genui/v1",
      root: "r",
      nodes: [
        { id: "r", component: "Stack", children: ["t"] },
        { id: "t", component: "Text", props: { value: 42 } },
      ],
    };
    expect(hostPropIssues(payload, [badge(stringTitle)])).toEqual([]);
  });
});
