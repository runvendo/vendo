import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildEnvironment } from "./env";
import type { RemixSourceRecord } from "@vendoai/core";

/** Fixture app with tsconfig @/* alias. */
function app(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vendo-env-local-"));
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
  );
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const record = (source: string): RemixSourceRecord => ({
  file: "src/components/w.tsx",
  source,
  sourceHash: "h",
  capturedAt: "2026-07-04T00:00:00.000Z",
});

describe("buildEnvironment local vendoring (fast-edits follow-up)", () => {
  it("bundles an app-local helper (with its transitive local closure) as a real module", async () => {
    const dir = app({
      "src/lib/cn.ts": `import { join } from "./join"\nexport const cn = (...a: unknown[]) => join(a);`,
      "src/lib/join.ts": `export const join = (a: unknown[]) => a.filter(Boolean).join(" ");`,
    });
    const { manifest } = await buildEnvironment(
      dir,
      { w: record(`import { cn } from "@/lib/cn"\nexport default function W(){ return null }`) },
      { now: () => "2026-07-04T00:00:00.000Z" },
    );
    expect(manifest.anchors["w"]?.["@/lib/cn"]?.kind).toBe("real");
    const map = JSON.parse(readFileSync(path.join(dir, ".vendo/env/import-map.json"), "utf8")) as {
      imports: Record<string, string>;
    };
    expect(map.imports["@/lib/cn"]).toMatch(/^\.\/vendor\/local-/);
    const bundled = readFileSync(
      path.join(dir, ".vendo/env", map.imports["@/lib/cn"]!),
      "utf8",
    );
    expect(bundled).toContain("filter(Boolean)"); // transitive closure inlined
  });

  it("externalizes react + separately-vendored npm; tolerates css imports", async () => {
    const dir = app({
      "src/components/ui/badge.tsx": `import { useMemo } from "react"\nimport { Star } from "lucide-react"\nimport "./badge.css"\nexport function Badge(){ const s = useMemo(() => Star, []); return s ? "b" : "c" }`,
      "src/components/ui/badge.css": `.badge { color: red }`,
    });
    const { manifest } = await buildEnvironment(
      dir,
      {
        w: record(
          `import { Badge } from "@/components/ui/badge"\nimport { Star } from "lucide-react"\nexport default function W(){ return null }`,
        ),
      },
      { now: () => "2026-07-04T00:00:00.000Z" },
    );
    expect(manifest.anchors["w"]?.["@/components/ui/badge"]?.kind).toBe("real");
    const map = JSON.parse(readFileSync(path.join(dir, ".vendo/env/import-map.json"), "utf8")) as {
      imports: Record<string, string>;
    };
    const bundled = readFileSync(
      path.join(dir, ".vendo/env", map.imports["@/components/ui/badge"]!),
      "utf8",
    );
    expect(bundled).toContain('from "react"'); // externalized, not inlined
    expect(bundled).toContain('from "lucide-react"'); // resolved via the import map
    expect(bundled).not.toContain("color: red"); // css import inert
  });

  it("refuses a closure that touches server-only code (falls back to absent)", async () => {
    const dir = app({
      "src/lib/data.ts": `import { secret } from "@/server/secrets"\nexport const data = () => secret;`,
      "src/server/secrets.ts": `export const secret = "k";`,
    });
    const { manifest, report } = await buildEnvironment(
      dir,
      { w: record(`import { data } from "@/lib/data"\nexport default function W(){ return null }`) },
      { now: () => "2026-07-04T00:00:00.000Z" },
    );
    expect(manifest.anchors["w"]?.["@/lib/data"]?.kind).toBe("absent");
    expect(report.join("\n")).toContain("could not vendor local");
    expect(existsSync(path.join(dir, ".vendo/env/vendor/local--lib-data.js"))).toBe(false);
  });

  it("refuses a local module that imports @vendoai/shell or unprovided bare packages", async () => {
    const dir = app({
      "src/lib/wrapper.ts": `import { VendoRemix } from "@vendoai/shell"\nexport const w = VendoRemix;`,
      "src/lib/heavy.ts": `import { motion } from "framer-motion"\nexport const m = motion;`,
    });
    const { manifest } = await buildEnvironment(
      dir,
      {
        w: record(
          `import { w } from "@/lib/wrapper"\nimport { m } from "@/lib/heavy"\nexport default function W(){ return null }`,
        ),
      },
      { now: () => "2026-07-04T00:00:00.000Z" },
    );
    expect(manifest.anchors["w"]?.["@/lib/wrapper"]?.kind).toBe("absent");
    // framer-motion is NOT imported by the component itself, so it is not in
    // the import map — a local module depending on it cannot ship as broken.
    expect(manifest.anchors["w"]?.["@/lib/heavy"]?.kind).toBe("absent");
  });
});
