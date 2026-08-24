/**
 * The engine, over a REAL just-bash filesystem — the same interface a
 * `WorkspaceFs` satisfies, so what passes here is what a turn gets.
 */
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createShellSession } from "../../src/vendo/shell/engine.js";

const disk = async (files: Record<string, string>): Promise<IFileSystem> => {
  const fs = new InMemoryFs();
  for (const [path, content] of Object.entries(files)) {
    await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await fs.writeFile(path, content);
  }
  return fs as unknown as IFileSystem;
};

describe("one shell session over the workspace", () => {
  it("greps a file the workspace holds", async () => {
    const workspace = await disk({
      "/user/threads/thr_1/files/ledger.csv": "month,revenue\njan,31000\nfeb,39000\n",
    });
    const session = createShellSession({ workspace });

    const result = await session.exec("grep -c , threads/thr_1/files/ledger.csv");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("3");
    expect(result.stderr).toBe("");
  });

  it("starts in /user, so the agent's paths are the user's paths", async () => {
    const session = createShellSession({ workspace: await disk({ "/user/files/a.txt": "hi\n" }) });

    expect((await session.exec("pwd")).stdout.trim()).toBe("/user");
    expect((await session.exec("cat files/a.txt")).stdout).toBe("hi\n");
  });

  it("reports a failing command instead of throwing", async () => {
    const session = createShellSession({ workspace: await disk({}) });

    const result = await session.exec("cat /user/nope.txt");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("No such file or directory");
  });

  it("gives the session a writable /tmp the workspace never sees", async () => {
    const workspace = await disk({ "/user/files/a.txt": "one\ntwo\n" });
    const session = createShellSession({ workspace });

    const wrote = await session.exec("sort files/a.txt > /tmp/sorted.txt");
    expect(wrote.exitCode).toBe(0);
    // Same session, second call: the scratch is still there.
    expect((await session.exec("cat /tmp/sorted.txt")).stdout).toBe("one\ntwo\n");
    // And it is NOT in the workspace — nothing to commit, nothing to leak.
    expect(await workspace.exists("/tmp/sorted.txt")).toBe(false);
  });

  it("refuses a write outside the mounts, because the filesystem does", async () => {
    // The refusal is the WORKSPACE's, never the engine's — `WorkspaceStoreFs`
    // raises EACCES outside the caller's mounts (store/src/workspace-fs.ts:229),
    // and this module deliberately bolts no check of its own on top. So the base
    // here is one that refuses, and what this proves is the engine's
    // non-interference: it surfaces the filesystem's EACCES rather than routing
    // around it. A bare `InMemoryFs` has no mounts and would assert nothing.
    const workspace = await disk({});
    const mounted = workspace.writeFile.bind(workspace);
    workspace.writeFile = async (path, data) => {
      if (!path.startsWith("/user/")) throw new Error(`EACCES: permission denied, open '${path}'`);
      return await mounted(path, data);
    };

    const result = await createShellSession({ workspace }).exec("echo pwned > /etc/passwd");

    expect(result.exitCode).not.toBe(0);
  });

  it("stops a command that will not stop", async () => {
    const session = createShellSession({
      workspace: await disk({}),
      limits: { maxExecutionTimeMs: 250 },
    });

    const result = await session.exec("while true; do echo spin > /dev/null; done");

    expect(result.exitCode).not.toBe(0);
  });

  it("stops a command that will not stop TALKING", async () => {
    const session = createShellSession({
      workspace: await disk({}),
      limits: { maxOutputBytes: 512 },
    });

    // `seq`, not `yes`: just-bash 3.4.2 ships no `yes`, and in a pipeline the
    // `command not found` is invisible — the exit code is `head`'s 0.
    const result = await session.exec("seq 1 100000");

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.length).toBeLessThan(4096);
  });
});
