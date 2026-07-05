import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildEnvironment } from "./env";
import type { RemixSourceRecord } from "@flowlet/core";

const record = (source: string): RemixSourceRecord => ({
  file: "src/w.tsx",
  source,
  sourceHash: "h",
  capturedAt: "2026-07-04T00:00:00.000Z",
});

describe("buildEnvironment shim wiring (Codex Critical #1)", () => {
  it("bundles imported shims and maps their specifiers so next/link + swr resolve", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flowlet-env-shims-"));
    const { manifest } = await buildEnvironment(
      dir,
      {
        w: record(
          `import Link from "next/link"\nimport useSWR from "swr"\nexport default function W(){ return null }`,
        ),
      },
      { now: () => "2026-07-04T00:00:00.000Z" },
    );
    const map = JSON.parse(readFileSync(path.join(dir, ".flowlet/env/import-map.json"), "utf8")) as {
      imports: Record<string, string>;
    };
    expect(map.imports["next/link"]).toMatch(/^\.\/vendor\/shim-/);
    expect(map.imports["swr"]).toMatch(/^\.\/vendor\/shim-/);
    // Manifest still marks them shimmed (real resolution, shim semantics).
    expect(manifest.anchors["w"]?.["next/link"]?.kind).toBe("shimmed");
    expect(manifest.anchors["w"]?.["swr"]?.kind).toBe("shimmed");
  });
});
