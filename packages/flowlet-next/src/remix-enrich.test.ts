import { describe, expect, it } from "vitest";
import type { FlowletUIMessage, RemixSourceRecord } from "@flowlet/core";
import { createSourceResolver, enrichAnchorSources, SOURCE_CAP_BYTES } from "./remix-enrich";

const record = (over: Partial<RemixSourceRecord> = {}): RemixSourceRecord => ({
  file: "src/components/dashboard/deadline-list.tsx",
  exportName: "DeadlineList",
  source: "export function DeadlineList() { return null }",
  sourceHash: "h1",
  capturedAt: "2026-07-04T00:00:00.000Z",
  ...over,
});

const scopedMessage = (over: Record<string, unknown> = {}): FlowletUIMessage => ({
  id: "m1",
  role: "user",
  parts: [{ type: "text", text: "customize" }],
  metadata: { anchors: { scoped: { anchorId: "upcoming-deadlines", ...over } } },
});

describe("createSourceResolver", () => {
  it("option map wins; resolver undefined falls through to the capture", () => {
    const resolve = createSourceResolver({
      option: (id) => (id === "a" ? "OPTION_SOURCE" : undefined),
      captured: { b: record({ source: "CAPTURED_SOURCE" }) },
      env: { NODE_ENV: "production" },
    });
    expect(resolve("a")).toBe("OPTION_SOURCE");
    expect(resolve("b")).toBe("CAPTURED_SOURCE");
    expect(resolve("c")).toBeUndefined();
  });

  it("dev mode re-reads the mapped file; production uses the captured copy", () => {
    const reads: string[] = [];
    const config = {
      captured: { x: record({ source: "STALE" }) },
      readFile: (file: string) => {
        reads.push(file);
        return "FRESH_FROM_DISK";
      },
      cwd: "/app",
    };
    const dev = createSourceResolver({ ...config, env: { NODE_ENV: "development" } });
    expect(dev("x")).toBe("FRESH_FROM_DISK");
    expect(reads[0]).toBe("/app/src/components/dashboard/deadline-list.tsx");

    const prod = createSourceResolver({ ...config, env: { NODE_ENV: "production" } });
    expect(prod("x")).toBe("STALE");
    expect(reads).toHaveLength(1); // no request-time filesystem reads in prod
  });

  it("dev read failure falls back to the captured copy; oversized sources truncate", () => {
    const resolve = createSourceResolver({
      captured: { x: record({ source: "CAPTURED" }) },
      readFile: () => {
        throw new Error("gone");
      },
      env: { NODE_ENV: "development" },
    });
    expect(resolve("x")).toBe("CAPTURED");

    const big = createSourceResolver({
      captured: { y: record({ source: "z".repeat(SOURCE_CAP_BYTES + 10) }) },
      env: { NODE_ENV: "production" },
    });
    expect(big("y")!.endsWith("[truncated]")).toBe(true);
  });
});

describe("enrichAnchorSources", () => {
  it("strips client-supplied source everywhere and enriches only the last user message", () => {
    const tampered = scopedMessage({ source: "FAKE_CLIENT_SOURCE" });
    const older: FlowletUIMessage = { ...scopedMessage({ source: "OLD_FAKE" }), id: "m0" };
    const enriched = enrichAnchorSources([older, tampered], () => "SERVER_SOURCE");
    expect(enriched[0]!.metadata?.anchors?.scoped?.source).toBeUndefined();
    expect(enriched[1]!.metadata?.anchors?.scoped?.source).toBe("SERVER_SOURCE");
    // Inputs untouched.
    expect(tampered.metadata?.anchors?.scoped?.source).toBe("FAKE_CLIENT_SOURCE");
  });

  it("strips even when no server source exists; leaves unscoped messages alone", () => {
    const plain: FlowletUIMessage = { id: "p", role: "user", parts: [{ type: "text", text: "hi" }] };
    const enriched = enrichAnchorSources([plain, scopedMessage({ source: "FAKE" })], () => undefined);
    expect(enriched[0]).toBe(plain);
    expect(enriched[1]!.metadata?.anchors?.scoped?.source).toBeUndefined();
    expect(enriched[1]!.metadata?.anchors?.scoped?.anchorId).toBe("upcoming-deadlines");
  });
});
