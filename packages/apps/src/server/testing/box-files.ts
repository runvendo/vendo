import type { SandboxMachine } from "../escalation/sandbox.js";

const textEncoder = new TextEncoder();

/**
 * The in-memory box filesystem every fake sandbox serves `files` from — one
 * implementation of the seam's three operations (sandbox.ts), so no two fakes
 * can drift into disagreeing about what reading a file means.
 *
 * `guard` is the fake's own lifecycle check. It runs for write and list and
 * NOT for read: a read stays available after stop/destroy on purpose, so the
 * fakes double as a post-mortem probe for tests asserting what a torn-down
 * machine held. Every other operation is lifecycle-guarded like a real
 * provider.
 */
export const inMemoryBoxFiles = (
  contents: Map<string, Uint8Array>,
  guard: (operation: string) => void = () => undefined,
): SandboxMachine["files"] => ({
  read: async (path: string): Promise<Uint8Array> => {
    const bytes = contents.get(path);
    if (bytes === undefined) throw new Error(`Unknown fake sandbox file: ${path}`);
    return bytes.slice();
  },
  write: async (path: string, bytes: Uint8Array | string): Promise<void> => {
    guard("write a file");
    contents.set(path, typeof bytes === "string" ? textEncoder.encode(bytes) : bytes.slice());
  },
  list: async (dir: string): Promise<string[]> => {
    guard("list files");
    // Box paths are ABSOLUTE, so the root's prefix is "/" — not "". An empty
    // prefix slices nothing off, leaving `/app/a.txt`.split("/")[0] === "",
    // which the empty-name filter below then drops: the root of a box full of
    // files listed as empty. Both spellings of root collapse onto this one
    // branch, so they cannot answer differently.
    const root = dir === "" || dir === "/";
    const prefix = root ? "/" : `${dir.replace(/\/$/, "")}/`;
    const names = [...new Set(
      [...contents.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length).split("/")[0])
        .filter((name): name is string => name !== undefined && name !== ""),
    )].sort();
    // A flat map cannot hold an EMPTY directory, so "nothing under this
    // prefix" is exactly "no such directory" — and the seam says that
    // rejects, like a real provider's lstat does. The ROOT is the exception:
    // it exists on every box, with files or without.
    if (names.length === 0 && !root) {
      throw new Error(`Unknown fake sandbox directory: ${dir}`);
    }
    return names;
  },
});
