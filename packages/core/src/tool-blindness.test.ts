import { describe, expect, it } from "vitest";
import { inputSchemaIsBlind } from "./tools.js";

describe("inputSchemaIsBlind", () => {
  it("calls the fail-closed placeholders blind", () => {
    // PERMISSIVE_INPUT (static-ts.ts / trpc.ts / route-schema.ts)
    expect(inputSchemaIsBlind({ type: "object", additionalProperties: true })).toBe(true);
    // route-scan's path-params-only base for a route with no path params
    expect(inputSchemaIsBlind({ type: "object", properties: {}, additionalProperties: true })).toBe(true);
    // nothing declared at all
    expect(inputSchemaIsBlind({})).toBe(true);
    expect(inputSchemaIsBlind(undefined)).toBe(true);
  });

  it("does NOT call a declared no-argument tool blind", () => {
    // an OpenAPI operation with no parameters — the spec DID declare the list
    expect(inputSchemaIsBlind({ type: "object", properties: {} })).toBe(false);
    // a server action with no parameters
    expect(inputSchemaIsBlind({ type: "object", properties: {}, additionalProperties: false })).toBe(false);
  });

  it("is never blind once a single argument is named", () => {
    expect(inputSchemaIsBlind({ type: "object", properties: { id: { type: "string" } }, additionalProperties: true })).toBe(false);
  });
});
