/**
 * `FsStat` is VENDORED from just-bash (`dist/fs/interface.d.ts`), and the
 * vendoring is only worth anything if it stays identical. A type has no runtime
 * to assert on, so the assertion is a structural one the compiler makes and this
 * test merely names: a stat carrying upstream's identity fields must satisfy
 * ours.
 */
import { describe, expect, it } from "vitest";
import type { FsStat } from "../src/filesystem.js";

describe("the vendored FsStat", () => {
  it("accepts upstream's optional identity fields", () => {
    const stat: FsStat = {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: 0o644,
      size: 3,
      mtime: new Date(0),
      dev: 1,
      ino: 2n,
      identity: "inode:2",
    };

    expect(stat.identity).toBe("inode:2");
  });
});
