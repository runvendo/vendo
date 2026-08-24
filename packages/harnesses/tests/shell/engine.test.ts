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
});
