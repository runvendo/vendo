import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultRunner, ignoreScriptsArgs, installStderrTail, zodBumpInvocation, ZOD_FLOOR_SPEC } from "../../src/cli/provider-deps.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function tempRoot(prefix = "vendo-provider-hygiene-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

// VEGA-INFO-00047 — Vendo's automatic dep repair shells the host package
// manager; without --ignore-scripts a malicious repo's lifecycle scripts run
// during `vendo init`. The repair must never execute host scripts.
describe("ignoreScriptsArgs", () => {
  it("passes --ignore-scripts to every manager that accepts it", () => {
    expect(ignoreScriptsArgs("npm")).toEqual(["--ignore-scripts"]);
    expect(ignoreScriptsArgs("pnpm")).toEqual(["--ignore-scripts"]);
    expect(ignoreScriptsArgs("bun")).toEqual(["--ignore-scripts"]);
  });

  it("omits it for yarn — berry rejects the flag, so the runner env covers yarn", () => {
    expect(ignoreScriptsArgs("yarn")).toEqual([]);
  });
});

describe("defaultRunner script suppression", () => {
  it("runs the install child with the script-ignoring env for the flag-less managers", async () => {
    const root = await tempRoot();
    const code = await defaultRunner(
      "node",
      ["-e", "process.stderr.write(`${process.env.npm_config_ignore_scripts}:${process.env.YARN_ENABLE_SCRIPTS}`, () => process.exit(1))"],
      root,
    );
    expect(code).toBe(1);
    expect(installStderrTail()).toBe("true:0");
  });
});

// VEGA-INFO-00091 — the paste-ready install command is displayed to the user
// (init/doctor) and its cwd carries repo-controlled path segments. An unquoted
// command breaks (and is unsafe) for any path with a space or shell metachar.
describe("invocationFor display quoting", () => {
  /** A nested npm-workspace app whose lockfile root (the printed cwd) carries
      `name`, forcing the `(cd <root> && …)` form. */
  async function nestedNpmApp(name: string): Promise<string> {
    const parent = await tempRoot();
    const workspace = join(parent, name);
    const app = join(workspace, "apps", "web");
    await mkdir(app, { recursive: true });
    await writeFile(join(workspace, "package-lock.json"), "{}");
    return app;
  }

  it("POSIX-quotes a cwd containing a space so the pasted command cannot be misread", async () => {
    const app = await nestedNpmApp("my host");
    const command = await zodBumpInvocation(app);
    expect(command).toMatch(/^\(cd '[^']*my host[^']*' && /);
    expect(command).toContain("npm install --workspace apps/web");
    // …while an ordinary caret spec stays unquoted (no over-quoting).
    expect(command).toContain(ZOD_FLOOR_SPEC);
    expect(command).not.toContain(`'${ZOD_FLOOR_SPEC}'`);
  });

  it("POSIX-quotes a cwd containing a shell metachar", async () => {
    const app = await nestedNpmApp("a$(whoami)b");
    const command = await zodBumpInvocation(app);
    expect(command).toMatch(/\(cd '[^']*a\$\(whoami\)b[^']*' && /);
  });
});
