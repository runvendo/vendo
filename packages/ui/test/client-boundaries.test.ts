import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every published entry is a React client boundary, and two facts have to hold
 * that no type error would ever catch:
 *   - `"use client"` survives into dist. tsc preserves the prologue today; a
 *     bundler swapped in later would drop it silently, and the host only finds
 *     out as "useState is not a function" in a server component.
 *   - no `export *`. Next's flight loader builds the client-reference manifest
 *     by statically enumerating a client module's named exports, and errors
 *     outright on a star.
 * The dist half reads the package's own build output — turbo's `test` task
 * depends on `build`, so it is there.
 */
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = ["index", "chrome/index", "kit/index", "tree/index"];

describe("client-boundary entries", () => {
  it.each(ENTRIES)('%s carries "use client" as the first line of dist', (entry) => {
    const built = readFileSync(join(PACKAGE_DIR, "dist", `${entry}.js`), "utf8");
    expect(built.split("\n")[0]).toBe('"use client";');
  });

  it.each(ENTRIES)("%s re-exports by name, never `export *`", (entry) => {
    const source = readFileSync(join(PACKAGE_DIR, "src", `${entry}.ts`), "utf8");
    expect(source).not.toMatch(/^export\s+\*/m);
  });
});
