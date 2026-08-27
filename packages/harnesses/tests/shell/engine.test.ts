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
    // The workspace's OWN sentence, verbatim — a non-zero exit alone would also
    // be satisfied by an engine that swallowed the EACCES and failed some other
    // way, which is the opposite of the non-interference this proves.
    expect(result.stderr).toContain("EACCES: permission denied, open '/etc/passwd'");
  });

  it("bounds that /tmp across the whole session, not just one call", async () => {
    // `maxOutputBytes` bounds ONE redirect (`redirection: total output size
    // exceeded`); nothing bounded the SESSION, so a turn that kept appending grew
    // `/tmp` without limit — 200 MB over 400 calls, measured. Raised here so the
    // ceiling is reached in a handful of copies rather than sixty appends.
    const session = createShellSession({ workspace: await disk({}), limits: { maxOutputBytes: 8_000_000 } });
    const repeat = (path: string, times: number): string => Array.from({ length: times }, () => path).join(" ");
    expect((await session.exec(`printf 'x%.0s' $(seq 1 100000) > /tmp/kb100`)).exitCode).toBe(0);
    expect((await session.exec(`cat ${repeat("/tmp/kb100", 10)} > /tmp/mb1`)).exitCode).toBe(0);
    expect((await session.exec(`cat ${repeat("/tmp/mb1", 5)} > /tmp/mb5`)).exitCode).toBe(0);

    let last = { exitCode: 0, stderr: "" };
    for (let copy = 0; copy < 8 && last.exitCode === 0; copy += 1) {
      // Each copy has to be its OWN bytes: `cp` alone shares one hard-link
      // buffer, so eight identical copies retain what one does.
      last = await session.exec(`cp /tmp/mb5 /tmp/copy${copy} && echo ${copy} >> /tmp/copy${copy}`);
    }

    expect(last.exitCode).not.toBe(0);
    expect(last.stderr).toContain("ENOSPC");
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

describe("the JavaScript hand", () => {
  it("runs a script that reads the workspace and writes back to it", async () => {
    const workspace = await disk({
      "/user/threads/thr_1/files/rows.json": JSON.stringify([{ n: 3 }, { n: 4 }, { n: 5 }]),
    });
    const session = createShellSession({ workspace, javascript: true });

    const result = await session.exec(
      `js-exec -c 'const fs = require("node:fs");
        const rows = JSON.parse(fs.readFileSync("/user/threads/thr_1/files/rows.json", "utf8"));
        fs.writeFileSync("/user/threads/thr_1/files/total.txt", String(rows.reduce((a, r) => a + r.n, 0)));
        console.log("done");'`,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("done");
    expect(await workspace.readFile("/user/threads/thr_1/files/total.txt")).toBe("12");
  });

  it("has no network inside the script", async () => {
    const session = createShellSession({ workspace: await disk({}), javascript: true });

    // AWAITED, not fire-and-forget: `fetch` IS defined in the sandbox, so an
    // unawaited promise only proves the script exited before it settled — which
    // it would do just as happily with the network working. What has to be proven
    // is that the call is REFUSED, in the sandbox's own words.
    const result = await session.exec(`js-exec -c 'await fetch("https://example.com"); console.log("reached")'`);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("reached");
    expect(result.stderr).toContain("Network access not configured");
  });

  it("has no js-exec at all when it was not asked for", async () => {
    const session = createShellSession({ workspace: await disk({}) });

    const result = await session.exec(`js-exec -c 'console.log(1)'`);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("js-exec");
  });
});
