import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareFixture,
  readFinalToolState,
  selectFixtures,
  stripVendoFromPackageJson,
  INSTALL_EVAL_FIXTURES,
  type InstallEvalFixture,
} from "./fixtures.js";

async function pathExists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

describe("selectFixtures", () => {
  it("defaults to the full set and rejects unknown names", () => {
    expect(selectFixtures([]).map((fixture) => fixture.name)).toEqual(
      INSTALL_EVAL_FIXTURES.map((fixture) => fixture.name),
    );
    expect(selectFixtures(["demo-bank"])).toHaveLength(1);
    expect(() => selectFixtures(["nope"])).toThrow(/Unknown install-eval fixture/);
  });
});

describe("stripVendoFromPackageJson", () => {
  it("removes every vendo dependency, override, and resolution", () => {
    const stripped = JSON.parse(stripVendoFromPackageJson(JSON.stringify({
      name: "app",
      dependencies: { "@vendoai/vendo": "workspace:*", vendoai: "^0.3.0", next: "16.0.0" },
      devDependencies: { "@vendoai/store": "workspace:*", vitest: "^2.0.0" },
      overrides: { "@vendoai/core": "file:vendor/x.tgz", "vendoai@0.3.0": "file:vendor/y.tgz", zod: "^3.24.0" },
      pnpm: { overrides: { "@vendoai/ui": "file:vendor/z.tgz" } },
    }))) as Record<string, unknown>;
    expect(stripped["dependencies"]).toEqual({ next: "16.0.0" });
    expect(stripped["devDependencies"]).toEqual({ vitest: "^2.0.0" });
    expect(stripped["overrides"]).toEqual({ zod: "^3.24.0" });
    expect(stripped["pnpm"]).toBeUndefined();
  });
});

describe("prepareFixture", () => {
  it("copies clean, strips the Vendo footprint, points npm at the registry, and snapshots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "install-eval-fixture-"));
    const sourceDir = path.join(root, "source-app");
    await mkdir(path.join(sourceDir, ".vendo"), { recursive: true });
    await mkdir(path.join(sourceDir, "node_modules", "junk"), { recursive: true });
    await mkdir(path.join(sourceDir, "src"), { recursive: true });
    await writeFile(path.join(sourceDir, "package.json"), JSON.stringify({
      name: "source-app",
      dependencies: { "@vendoai/vendo": "workspace:*", express: "^5.0.0" },
    }));
    await writeFile(path.join(sourceDir, ".vendo", "tools.json"), "{}");
    await writeFile(path.join(sourceDir, "CLAUDE.md"), "monorepo context");
    await writeFile(path.join(sourceDir, "pnpm-lock.yaml"), "lockfileVersion: 9");
    await writeFile(path.join(sourceDir, "src", "server.ts"), "export {};");

    const fixture: InstallEvalFixture = {
      name: "unit-fixture",
      sourcePath: "source-app",
      devServer: { command: "true", readinessUrl: "http://127.0.0.1:1" },
      doctorUrl: "http://127.0.0.1:1/api/vendo",
    };
    const fixtureDir = await prepareFixture({
      fixture,
      workspaceRoot: root,
      fixturesRoot: path.join(root, "out"),
      registryUrl: "http://127.0.0.1:4873",
    });

    expect(await pathExists(path.join(fixtureDir, ".vendo"))).toBe(false);
    expect(await pathExists(path.join(fixtureDir, "node_modules"))).toBe(false);
    expect(await pathExists(path.join(fixtureDir, "CLAUDE.md"))).toBe(false);
    expect(await pathExists(path.join(fixtureDir, "pnpm-lock.yaml"))).toBe(false);
    expect(await pathExists(path.join(fixtureDir, "src", "server.ts"))).toBe(true);

    const pkg = JSON.parse(await readFile(path.join(fixtureDir, "package.json"), "utf8")) as Record<string, unknown>;
    expect(pkg["dependencies"]).toEqual({ express: "^5.0.0" });
    expect(await readFile(path.join(fixtureDir, ".npmrc"), "utf8")).toBe("registry=http://127.0.0.1:4873/\n");
    // One-commit git snapshot so agent edits stay diffable.
    expect(await pathExists(path.join(fixtureDir, ".git"))).toBe(true);
  });
});

describe("readFinalToolState", () => {
  it("collects generated tool names and referenced names", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "install-eval-state-"));
    await mkdir(path.join(dir, ".vendo"), { recursive: true });
    await writeFile(path.join(dir, ".vendo", "tools.json"), JSON.stringify({
      tools: [{ name: "host_accounts_list" }, { name: "host_transfers_create" }],
    }));
    await writeFile(path.join(dir, ".vendo", "overrides.json"), JSON.stringify({
      tools: { host_accounts_list: { disabled: true }, host_invented: {} },
    }));
    await writeFile(path.join(dir, ".vendo", "policy.json"), JSON.stringify({
      rules: [
        { match: { risk: "read" }, action: "run" },
        { match: { tool: "host_transfers_create" }, action: "ask" },
      ],
    }));
    const state = await readFinalToolState(dir);
    expect(state.toolNames).toEqual(["host_accounts_list", "host_transfers_create"]);
    expect(state.referencedToolNames.sort()).toEqual(["host_accounts_list", "host_invented", "host_transfers_create"]);
  });

  it("reads empty state when nothing was generated", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "install-eval-state-empty-"));
    expect(await readFinalToolState(dir)).toEqual({ toolNames: [], referencedToolNames: [] });
  });
});
