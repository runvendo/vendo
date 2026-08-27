/**
 * `FsStat` is VENDORED from just-bash (`dist/fs/interface.d.ts`), and the
 * vendoring is only worth anything if it stays identical. A type has no runtime
 * to assert on, so the assertion is a structural one the compiler makes —
 * against UPSTREAM's own declaration, not a literal maintained by hand here,
 * which would keep passing through any drift on their side.
 */
import { InMemoryFs, type FsStat as UpstreamFsStat } from "just-bash";
import { describe, expect, it } from "vitest";
import type { FsStat } from "../src/filesystem.js";

/** Identical, for a structural type, is assignable BOTH ways: a renamed field, a
 *  widened member, or a key that became required breaks one direction or the
 *  other, and `pnpm typecheck` is where it says so. */
type Assignable<A, B> = A extends B ? true : never;
export const upstreamSatisfiesOurs: Assignable<UpstreamFsStat, FsStat> = true;
export const oursSatisfiesUpstream: Assignable<FsStat, UpstreamFsStat> = true;

describe("the vendored FsStat", () => {
  it("accepts what upstream's own filesystem hands back", async () => {
    const fs = new InMemoryFs();
    await fs.writeFile("/ledger.csv", "jan\n");

    // The annotation IS the seam: upstream's real `stat()` return type has to
    // flow into our vendored one, and the values below are upstream's real ones.
    const stat: FsStat = await fs.stat("/ledger.csv");

    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.size).toBe(4);
    expect(stat.mtime).toBeInstanceOf(Date);
  });
});
