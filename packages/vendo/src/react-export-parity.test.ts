import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// react.tsx is a "use client" boundary. Next's flight loader builds a
// client-reference manifest by statically enumerating a client module's named
// exports; it cannot do that through `export * from "@vendoai/ui"` ("export *
// in a client boundary" build error). The fix is explicit named re-exports —
// this test both bans the `export *` regression and makes a future
// `@vendoai/ui` addition that react.tsx forgets to re-export fail loudly here
// instead of silently missing from the client surface.

const reactSourcePath = fileURLToPath(new URL("./react.tsx", import.meta.url));

describe("react.tsx client-boundary re-exports of @vendoai/ui", () => {
  it("does not use `export *` (Next's flight loader can't enumerate it across a use-client boundary)", () => {
    const source = readFileSync(reactSourcePath, "utf8");
    expect(source).not.toMatch(/export\s+\*\s+from\s+["']@vendoai\/ui["']/);
  });

  it("names every current @vendoai/ui runtime export explicitly", async () => {
    const ui = await import("@vendoai/ui");
    const reactEntry = await import("./react.js");

    const uiKeys = Object.keys(ui).sort();
    expect(uiKeys.length).toBeGreaterThan(0);

    const missing = uiKeys.filter((key) => !(key in reactEntry));
    expect(missing, `react.tsx is missing named re-exports for: ${missing.join(", ")}`).toEqual([]);
  });
});
