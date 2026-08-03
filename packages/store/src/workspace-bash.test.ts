import type { Principal } from "@vendoai/core";
import { Bash } from "just-bash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { workspaceBash } from "./workspace-bash.js";
import { workspaceStore } from "./workspace.js";

// N6 (verifier): just-bash's default cwd is /home/user — outside both mounts —
// so every relative write threw out of exec and killed the turn, while /tmp
// (which an LLM reaches for constantly) was hard-refused. The canonical factory
// is the answer: cwd inside /user/scratch, /tmp as a bash-level view of it, and
// refusals as command failures instead of uncaught throws.

const user: Principal = { kind: "user", subject: "user_bash_factory" };

for (const backend of backends()) {
  describe(`${backend.name} the canonical bash setup`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    const shell = async (): Promise<{
      run: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
      workspace: Awaited<ReturnType<ReturnType<typeof workspaceStore>["open"]>>;
    }> => {
      const workspace = await workspaceStore(made.store).open(user);
      const setup = workspaceBash(workspace);
      const bash = new Bash({ fs: setup.fs, cwd: setup.cwd, env: setup.env });
      return { run: setup.run((command) => bash.exec(command)), workspace };
    };

    it("writes relative paths without a thrown error, from a cwd inside the workspace", async () => {
      const { run } = await shell();

      expect((await run("pwd")).stdout.trim()).toMatch(/^\/user\/scratch/);
      const wrote = await run("echo hello > notes.txt && cat notes.txt");
      expect(wrote.exitCode).toBe(0);
      expect(wrote.stdout.trim()).toBe("hello");
    });

    it("presents /tmp as a view of /user/scratch, so the store never sees /tmp", async () => {
      const { run, workspace } = await shell();

      expect((await run("echo scratched > /tmp/work.txt")).exitCode).toBe(0);
      expect((await run("cat /tmp/work.txt")).stdout.trim()).toBe("scratched");
      // Same file through the real path.
      expect((await run("cat /user/scratch/work.txt")).stdout.trim()).toBe("scratched");
      expect((await run("ls /tmp")).stdout).toContain("work.txt");

      // And nothing about /tmp reaches the store.
      expect(await workspace.commit()).toEqual({ status: "ok", changed: [] });
      const rows = await made.sql(
        "SELECT path FROM vendo_workspace_files WHERE path LIKE '%tmp%' OR path LIKE '/user/scratch/%'",
      );
      expect(rows).toEqual([]);
    });

    it("keeps TMPDIR pointed at the same place bash writes", async () => {
      const { run } = await shell();
      expect((await run("echo $TMPDIR")).stdout.trim()).toBe("/tmp");
      expect((await run("echo via-tmpdir > $TMPDIR/t.txt && cat /user/scratch/t.txt")).stdout.trim())
        .toBe("via-tmpdir");
    });

    it("surfaces a refused path as a command failure, never an uncaught throw", async () => {
      const { run } = await shell();

      for (const command of ["echo mine > /etc/passwd", "echo mine > /host/skills/x/SKILL.md"]) {
        const refused = await run(command);
        expect(refused.exitCode).not.toBe(0);
        expect(refused.stderr).toMatch(/permission denied|read-only file system/);
        // Readable: it says which path, not just a code.
        expect(refused.stderr).toMatch(/\/etc\/passwd|SKILL\.md/);
      }
    });

    it("still commits real workspace edits made through the shell", async () => {
      const { run, workspace } = await shell();
      const app = "/user/apps/app_shell/app.vendo";
      await workspace.writeFile(app, "chart: revenue\n");

      expect((await run(`sed -i 's/revenue/margin/' ${app}`)).exitCode).toBe(0);
      expect(await workspace.commit({ message: "renamed it" }))
        .toEqual({ status: "ok", changed: [app] });
      expect(String((await made.sql(
        "SELECT content FROM vendo_workspace_files WHERE path = $1",
        [app],
      ))[0]?.["content"])).toContain("margin");
    });
  });
}
