import { describe, it, expect } from "vitest";
import { SCHEMA_VERSION, type ActionRequest, type FlowletMetadata } from "./protocol";

describe("protocol", () => {
  it("exposes a schema version", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("types a sandbox action request with a correlation id", () => {
    const req: ActionRequest = { requestId: "r1", originNodeId: "n1", action: "click" };
    expect(req.requestId).toBe("r1");
  });

  it("metadata optionally carries the anchor context block", () => {
    // Backward compatible: metadata without anchors stays valid.
    const bare: FlowletMetadata = { runId: "r1", threadId: "t1", schemaVersion: SCHEMA_VERSION };
    expect(bare.anchors).toBeUndefined();

    // Scoped send: the clicked anchor, snapshot included.
    const scoped: FlowletMetadata = {
      runId: "r2",
      threadId: "t1",
      schemaVersion: SCHEMA_VERSION,
      anchors: {
        scoped: {
          anchorId: "invoices-widget",
          label: "Outstanding invoices",
          context: { rows: 3 },
          snapshot: "<div class=\"invoices\">…</div>",
        },
      },
    };
    expect(scoped.anchors?.scoped?.anchorId).toBe("invoices-widget");

    // Plain Cmd+K send: ambient anchors only, never snapshots.
    const ambient: FlowletMetadata = {
      runId: "r3",
      threadId: "t1",
      schemaVersion: SCHEMA_VERSION,
      anchors: {
        ambient: [
          { anchorId: "invoices-widget", label: "Outstanding invoices", context: { rows: 3 } },
          { anchorId: "deadline-list", label: "Deadlines" },
        ],
      },
    };
    expect(ambient.anchors?.ambient).toHaveLength(2);
  });
});
