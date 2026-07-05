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
    expect(resolve("a")?.source).toBe("OPTION_SOURCE");
    expect(resolve("b")?.source).toBe("CAPTURED_SOURCE");
    expect(resolve("c")).toBeUndefined();
  });

  it("resolved records carry exportName, sourceHash, and truncated", () => {
    const resolve = createSourceResolver({
      captured: { b: record({ source: "CAPTURED_SOURCE", sourceHash: "cap-hash" }) },
      env: { NODE_ENV: "production" },
    });
    const rec = resolve("b")!;
    expect(rec.exportName).toBe("DeadlineList");
    expect(rec.sourceHash).toBe("cap-hash");
    expect(rec.truncated).toBe(false);
    // Option-sourced text has no capture record: hash is computed, no exportName.
    const opt = createSourceResolver({
      option: { a: "OPTION_SOURCE" },
      captured: {},
      env: { NODE_ENV: "production" },
    })("a")!;
    expect(opt.exportName).toBeUndefined();
    expect(opt.sourceHash).toMatch(/^[0-9a-f]{64}$/);
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
    expect(dev("x")?.source).toBe("FRESH_FROM_DISK");
    expect(reads[0]).toBe("/app/src/components/dashboard/deadline-list.tsx");

    const prod = createSourceResolver({ ...config, env: { NODE_ENV: "production" } });
    expect(prod("x")?.source).toBe("STALE");
    expect(reads).toHaveLength(1); // no request-time filesystem reads in prod
  });

  it("rejects a traversal file path and falls back to the captured copy (Codex review)", () => {
    const reads: string[] = [];
    const resolve = createSourceResolver({
      captured: { x: record({ file: "../../etc/passwd", source: "CAPTURED" }) },
      readFile: (file) => {
        reads.push(file);
        return "SECRET";
      },
      cwd: "/app",
      env: { NODE_ENV: "development" },
    });
    expect(resolve("x")?.source).toBe("CAPTURED"); // never read the traversal target
    expect(reads).toHaveLength(0);
  });

  it("dev read failure falls back to the captured copy; oversized sources truncate", () => {
    const resolve = createSourceResolver({
      captured: { x: record({ source: "CAPTURED" }) },
      readFile: () => {
        throw new Error("gone");
      },
      env: { NODE_ENV: "development" },
    });
    expect(resolve("x")?.source).toBe("CAPTURED");

    const big = createSourceResolver({
      captured: { y: record({ source: "z".repeat(SOURCE_CAP_BYTES + 10) }) },
      env: { NODE_ENV: "production" },
    });
    const rec = big("y")!;
    expect(rec.source.endsWith("[truncated]")).toBe(true);
    expect(rec.truncated).toBe(true);
  });
});

describe("enrichAnchorSources", () => {
  const server = () => ({ source: "SERVER_SOURCE", sourceHash: "sh", truncated: false });

  it("strips client-supplied remixSource/pinBase everywhere and enriches only the last user message", () => {
    const tampered = scopedMessage({
      remixSource: { source: "FAKE_CLIENT_SOURCE", sourceHash: "x", truncated: false },
      pinBase: { payload: {}, sources: {}, baseHash: "x", sourceHash: "x" },
    });
    const older: FlowletUIMessage = {
      ...scopedMessage({ remixSource: { source: "OLD_FAKE", sourceHash: "x", truncated: false } }),
      id: "m0",
    };
    const enriched = enrichAnchorSources([older, tampered], server);
    expect(enriched[0]!.metadata?.anchors?.scoped?.remixSource).toBeUndefined();
    expect(enriched[1]!.metadata?.anchors?.scoped?.remixSource?.source).toBe("SERVER_SOURCE");
    expect(enriched[1]!.metadata?.anchors?.scoped?.pinBase).toBeUndefined();
    // Inputs untouched.
    expect(tampered.metadata?.anchors?.scoped?.remixSource?.source).toBe("FAKE_CLIENT_SOURCE");
  });

  it("keeps the client envelope ONLY on the last user message (verification input)", () => {
    const older: FlowletUIMessage = { ...scopedMessage({ envelope: "sealed-old" }), id: "m0" };
    const last = scopedMessage({ envelope: "sealed-current" });
    const enriched = enrichAnchorSources([older, last], () => undefined);
    expect(enriched[0]!.metadata?.anchors?.scoped?.envelope).toBeUndefined();
    expect(enriched[1]!.metadata?.anchors?.scoped?.envelope).toBe("sealed-current");
  });

  it("strips even when no server source exists; leaves unscoped messages alone", () => {
    const plain: FlowletUIMessage = { id: "p", role: "user", parts: [{ type: "text", text: "hi" }] };
    const enriched = enrichAnchorSources(
      [plain, scopedMessage({ remixSource: { source: "FAKE", sourceHash: "x", truncated: false } })],
      () => undefined,
    );
    expect(enriched[0]).toBe(plain);
    expect(enriched[1]!.metadata?.anchors?.scoped?.remixSource).toBeUndefined();
    expect(enriched[1]!.metadata?.anchors?.scoped?.anchorId).toBe("upcoming-deadlines");
  });
});
