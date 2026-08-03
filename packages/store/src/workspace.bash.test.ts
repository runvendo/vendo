import type { Principal } from "@vendoai/core";
import { Bash } from "just-bash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { workspaceStore } from "./workspace.js";

// Build contract §3.2 / design §8: implementing just-bash's IFileSystem over
// the store is what gives a machine-less harness real bash — grep, sed, awk,
// jq — over the workspace with NO sandbox. These tests are that claim, run.

const user: Principal = { kind: "user", subject: "user_bash" };
const APP = "/user/apps/app_bash/app.vendo";

for (const backend of backends()) {
  describe(`${backend.name} in-process bash over the workspace façade`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("greps a committed workspace file with no sandbox anywhere", async () => {
      const workspace = workspaceStore(made.store);
      const seed = await workspace.open(user);
      await seed.writeFile(APP, "page: Overview\nchart: revenue\nchart: churn\n");
      await seed.writeFile("/user/memory/notes.md", "the user prefers bar charts\n");
      await seed.commit({ message: "made an overview" });

      const fs = await workspace.open(user);
      const bash = new Bash({ fs, cwd: "/user" });

      const grep = await bash.exec(`grep -c chart ${APP}`);
      expect(grep.exitCode).toBe(0);
      expect(grep.stdout.trim()).toBe("2");

      const listing = await bash.exec("ls apps/app_bash");
      expect(listing.stdout.trim()).toBe("app.vendo");

      const chain = await bash.exec("grep chart apps/app_bash/app.vendo | awk '{print $2}' | sort");
      expect(chain.stdout.trim().split("\n")).toEqual(["churn", "revenue"]);
    });

    it("sed -i edits a workspace file, and commit lands exactly that one row", async () => {
      const workspace = workspaceStore(made.store);
      const fs = await workspace.open(user);
      const bash = new Bash({ fs, cwd: "/user" });

      const sed = await bash.exec(`sed -i 's/revenue/margin/' ${APP}`);
      expect(sed.exitCode).toBe(0);
      expect(await fs.readFile(APP)).toContain("chart: margin");

      const commit = await fs.commit({ message: "renamed the revenue chart" });
      expect(commit).toEqual({ status: "ok", changed: [APP] });

      const rows = await made.sql(
        "SELECT content, revision FROM vendo_workspace_files WHERE path = $1",
        [APP],
      );
      expect(rows[0]?.["content"]).toBe("page: Overview\nchart: margin\nchart: churn\n");
      expect(Number(rows[0]?.["revision"])).toBe(2);

      // The next turn's harness — a different façade — sees the edit.
      const next = await workspace.open(user);
      expect(await next.readFile(APP)).toContain("chart: margin");
    });

    it("globs across both mounts, which is what the synchronous path index is for", async () => {
      const workspace = workspaceStore(made.store);
      const seed = await workspace.open(user);
      await seed.writeFile("/user/apps/app_glob_a/app.vendo", "a\n");
      await seed.writeFile("/user/apps/app_glob_b/app.vendo", "b\n");
      await seed.commit();

      const fs = await workspace.open(user, {
        host: {
          "/host/skills/charting/SKILL.md": "# Charting\n",
          "/host/skills/tables/SKILL.md": "# Tables\n",
        },
      });
      const bash = new Bash({ fs, cwd: "/user" });

      const apps = await bash.exec("ls /user/apps/*/app.vendo | sort");
      expect(apps.stdout.trim().split("\n")).toEqual([
        "/user/apps/app_bash/app.vendo",
        "/user/apps/app_glob_a/app.vendo",
        "/user/apps/app_glob_b/app.vendo",
      ]);

      const skills = await bash.exec("ls /host/skills/*/SKILL.md | sort");
      expect(skills.stdout.trim().split("\n")).toEqual([
        "/host/skills/charting/SKILL.md",
        "/host/skills/tables/SKILL.md",
      ]);
    });

    it("refuses to write /host from inside bash", async () => {
      const skill = "/host/skills/charting/SKILL.md";
      const fs = await workspaceStore(made.store).open(user, { host: { [skill]: "# Charting\n" } });
      const bash = new Bash({ fs, cwd: "/user" });

      expect((await bash.exec(`cat ${skill}`)).stdout).toContain("# Charting");
      // just-bash surfaces a read-only mount's refusal by propagating the fs
      // error out of exec (the documented behaviour of its own `readOnly`
      // filesystems), so the write cannot be mistaken for a success.
      await expect(bash.exec(`echo mine > ${skill}`)).rejects.toThrow(/EROFS: read-only file system/);
      // sed -i reports the refused write in its own words; what matters is that
      // it fails rather than reporting success.
      expect((await bash.exec(`sed -i 's/Charting/Mine/' ${skill}`)).exitCode).not.toBe(0);
      expect(await fs.readFile(skill)).toBe("# Charting\n");
    });

    it("keeps bash's own scratch out of the store", async () => {
      const workspace = workspaceStore(made.store);
      const fs = await workspace.open(user);
      const bash = new Bash({ fs, cwd: "/user/scratch" });

      const piped = await bash.exec(
        "echo 'b\na' > sorted.txt && sort sorted.txt | tr '\\n' ' '",
      );
      expect(piped.stdout.trim()).toBe("a b");

      expect(await fs.commit()).toEqual({ status: "ok", changed: [] });
      const rows = await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_workspace_files WHERE path LIKE '/user/scratch/%'",
      );
      expect(Number(rows[0]?.["count"])).toBe(0);
    });
  });
}
