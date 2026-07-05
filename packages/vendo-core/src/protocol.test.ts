import { describe, it, expect } from "vitest";
import { SCHEMA_VERSION, type ActionRequest, type VendoMetadata } from "./protocol";

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
    const bare: VendoMetadata = { runId: "r1", threadId: "t1", schemaVersion: SCHEMA_VERSION };
    expect(bare.anchors).toBeUndefined();

    // Scoped send: the clicked anchor, snapshot included.
    const scoped: VendoMetadata = {
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

    // Scoped block may carry server-enriched source (remix-fidelity epic).
    const sourced: VendoMetadata = {
      runId: "r4",
      threadId: "t1",
      schemaVersion: SCHEMA_VERSION,
      anchors: {
        scoped: {
          anchorId: "invoices-widget",
          snapshot: "<div/>",
          source: "export function InvoiceList() { return null }",
        },
      },
    };
    expect(sourced.anchors?.scoped?.source).toContain("InvoiceList");

    // Plain Cmd+K send: ambient anchors only, never snapshots.
    const ambient: VendoMetadata = {
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

  it("types the sync artifacts: RemixSourceRecord, resolver, and env manifest", async () => {
    const { SCHEMA_VERSION: _v } = await import("./protocol");
    const record: import("./protocol").RemixSourceRecord = {
      file: "src/components/dashboard/deadline-list.tsx",
      exportName: "DeadlineList",
      source: "export function DeadlineList() {}",
      sourceHash: "abc123",
      capturedAt: "2026-07-04T00:00:00.000Z",
    };
    expect(record.exportName).toBe("DeadlineList");

    const resolver: import("./protocol").RemixSourceResolver = (id) =>
      id === "upcoming-deadlines" ? record.source : undefined;
    expect(resolver("nope")).toBeUndefined();

    const manifest: import("./protocol").EnvManifest = {
      anchors: {
        "upcoming-deadlines": {
          "lucide-react": { kind: "real" },
          swr: { kind: "shimmed", note: "resolves anchor data; fetcher never runs" },
          "next/headers": { kind: "absent", alternative: "server-only — not available" },
        },
      },
      vendorSizes: { "lucide-react": 41_000 },
    };
    expect(manifest.anchors["upcoming-deadlines"]!["swr"]!.kind).toBe("shimmed");
  });
});
