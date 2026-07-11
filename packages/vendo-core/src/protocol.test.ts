import { describe, it, expect } from "vitest";
import { SCHEMA_VERSION, type ActionRequest, type VendoMetadata } from "./protocol.js";

describe("protocol", () => {
  it("exposes a schema version", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("types a sandbox action request with a correlation id", () => {
    const req: ActionRequest = { requestId: "r1", originNodeId: "n1", action: "click" };
    expect(req.requestId).toBe("r1");
  });

  it("types run metadata", () => {
    const bare: VendoMetadata = { runId: "r1", threadId: "t1", schemaVersion: SCHEMA_VERSION };
    expect(bare.runId).toBe("r1");
  });
});
