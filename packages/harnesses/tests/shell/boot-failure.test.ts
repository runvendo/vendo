/**
 * A shell that cannot BOOT, over the real engine.
 *
 * Its own file because the seam is a module: the shell loads its libraries
 * bundler-blind at first use, so a load failure can only be injected by
 * replacing `runtime.js`, and `vi.mock` is file-wide. Everything the assertions
 * touch is real — the engine, just-bash, the filesystem, the retry.
 */
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";

/** Set for the next library load only, then cleared — a blink, not a break. */
let blink = false;

vi.mock("../../src/vendo/shell/runtime.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/vendo/shell/runtime.js")>();
  return {
    ...real,
    importShellLibrary: async (specifier: string) => {
      if (!blink) return await real.importShellLibrary(specifier);
      blink = false;
      // The sentence Node itself produces when a bundled chunk cannot see this
      // package's node_modules — the failure this really hit in a host app.
      throw new Error(`Cannot find package '${specifier}' imported from /host/.next/chunk.js`);
    },
  };
});

// Imported AFTER the mock declaration; `vi.mock` is hoisted, so `engine.ts`
// binds the double.
const { createShellSession } = await import("../../src/vendo/shell/engine.js");

const disk = async (files: Record<string, string>): Promise<IFileSystem> => {
  const fs = new InMemoryFs();
  for (const [path, content] of Object.entries(files)) {
    await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await fs.writeFile(path, content);
  }
  return fs as unknown as IFileSystem;
};

describe("a shell whose interpreter will not load", () => {
  it("reports the failure the model can read instead of throwing out of the call", async () => {
    const session = createShellSession({ workspace: await disk({ "/user/files/a.txt": "hi\n" }) });
    blink = true;

    const result = await session.exec("cat files/a.txt");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Cannot find package 'just-bash'");
    expect(result.stdout).toBe("");
  });

  it("does not cache the failure, so the next call in the same turn still works", async () => {
    const session = createShellSession({ workspace: await disk({ "/user/files/a.txt": "hi\n" }) });
    blink = true;
    expect((await session.exec("cat files/a.txt")).exitCode).not.toBe(0);

    // Same session. A cached rejection would answer with the boot error forever.
    const result = await session.exec("cat files/a.txt");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
  });
});
