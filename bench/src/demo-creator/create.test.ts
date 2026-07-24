import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDemoConfig } from "demo-template/demo-config";
import { describe, expect, it } from "vitest";
import { cloneExclusions, displayAppPath, parseDemoCreateArgs, runDemoCreate } from "./create.js";

describe("displayAppPath", () => {
  it("prefers the repo-root-relative shape and falls back to absolute outside the repo", () => {
    expect(displayAppPath("/repo", "/repo/apps/demo-acme")).toBe("apps/demo-acme");
    expect(displayAppPath("/repo", "/tmp/scratch/demo-acme")).toBe("/tmp/scratch/demo-acme");
  });
});

describe("parseDemoCreateArgs", () => {
  it("parses a fully specified create", () => {
    expect(parseDemoCreateArgs([
      "--id", "acme-widgets",
      "--prospect", "Acme Widgets",
      "--cta-url", "https://cal.com/someone",
      "--target-dir", "/tmp/scratch",
      "--url", "https://acme.example",
    ])).toEqual({
      id: "acme-widgets",
      prospect: "Acme Widgets",
      ctaUrl: "https://cal.com/someone",
      targetDir: "/tmp/scratch",
      url: "https://acme.example",
    });
  });

  it("defaults the CTA and target directory", () => {
    expect(parseDemoCreateArgs(["--id", "acme", "--prospect", "Acme"])).toEqual({
      id: "acme",
      prospect: "Acme",
      ctaUrl: "https://cal.com/yousefhelal",
      targetDir: "apps",
    });
  });

  it("accepts the literal separator forwarded by pnpm scripts", () => {
    expect(parseDemoCreateArgs(["--", "--id", "acme", "--prospect", "Acme"]))
      .toMatchObject({ id: "acme", prospect: "Acme" });
  });

  it("requires --id and --prospect", () => {
    expect(() => parseDemoCreateArgs(["--prospect", "Acme"])).toThrow("--id is required");
    expect(() => parseDemoCreateArgs(["--id", "acme"])).toThrow("--prospect is required");
  });

  it("rejects unknown options and missing values", () => {
    expect(() => parseDemoCreateArgs(["--id", "acme", "--prospect", "Acme", "--nope", "x"]))
      .toThrow("Unknown option: --nope");
    expect(() => parseDemoCreateArgs(["--id"])).toThrow("--id requires a value");
  });

  it("rejects a prospect --url that is not http(s)", () => {
    expect(() => parseDemoCreateArgs(["--id", "acme", "--prospect", "Acme", "--url", "not a url"]))
      .toThrow("--url must be an http(s) URL");
  });
});

describe("runDemoCreate", () => {
  const templateConfig = {
    id: "template-sample",
    prospect: "Template Sample",
    ctaUrl: "https://cal.com/yousefhelal",
    beats: [
      { key: "generate-ui", prompt: "Show me a dashboard of my data", chip: "Dashboard of my data", expectsView: true },
      { key: "take-action", prompt: "Archive the item named Bravo", chip: "Archive an item, with approval", expectsApproval: true },
      { key: "save-app", prompt: "Save this dashboard as a reusable app", chip: "Save this as an app" },
    ],
    caps: { maxTurns: 20, maxSpendUsd: 5 },
    expiresAt: "2099-01-01T00:00:00Z",
  };

  /** A miniature apps/demo-template inside a temp repo root, including the
   * junk a clone must never carry over. */
  async function writeRepoFixture(): Promise<string> {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "vendo-demo-create-"));
    const templateDir = path.join(repoRoot, "apps", "demo-template");
    for (const dir of [".vendo/data/base", "node_modules/next", ".next/server", "docs/verification", "src/lib"]) {
      await mkdir(path.join(templateDir, dir), { recursive: true });
    }
    await writeFile(path.join(templateDir, "package.json"), `${JSON.stringify({
      name: "demo-template",
      version: "0.1.0",
      private: true,
      scripts: { dev: "next dev" },
    }, null, 2)}\n`);
    await writeFile(path.join(templateDir, "demo.config.json"), `${JSON.stringify(templateConfig, null, 2)}\n`);
    await writeFile(path.join(templateDir, ".vendo", "theme.json"), "{}\n");
    await writeFile(path.join(templateDir, ".vendo", "data", "base", "junk.db"), "junk\n");
    await writeFile(path.join(templateDir, "node_modules", "next", "package.json"), "{}\n");
    await writeFile(path.join(templateDir, ".next", "server", "junk.js"), "junk\n");
    await writeFile(path.join(templateDir, "docs", "verification", "shot.png"), "junk\n");
    await writeFile(path.join(templateDir, "docs", "notes.md"), "keep\n");
    await writeFile(path.join(templateDir, "src", "lib", "demo-config.ts"), "export {}\n");
    await writeFile(path.join(templateDir, "VERIFY.md"), "keep\n");
    return repoRoot;
  }

  const args = {
    id: "acme-widgets",
    prospect: "Acme Widgets",
    ctaUrl: "https://cal.com/yousefhelal",
    targetDir: "apps",
  };

  it("clones the template without junk and keeps the kept files", async () => {
    const repoRoot = await writeRepoFixture();
    const { appDir } = await runDemoCreate(args, { repoRoot });
    expect(appDir).toBe(path.join(repoRoot, "apps", "demo-acme-widgets"));
    for (const kept of ["VERIFY.md", "docs/notes.md", "src/lib/demo-config.ts", ".vendo/theme.json"]) {
      expect(existsSync(path.join(appDir, kept)), `${kept} should be cloned`).toBe(true);
    }
    for (const excluded of cloneExclusions) {
      expect(existsSync(path.join(appDir, excluded)), `${excluded} should be excluded`).toBe(false);
    }
  });

  it("renames the cloned package and keeps the rest of package.json", async () => {
    const repoRoot = await writeRepoFixture();
    const { appDir, packageName } = await runDemoCreate(args, { repoRoot });
    expect(packageName).toBe("demo-acme-widgets");
    const packageJson = JSON.parse(await readFile(path.join(appDir, "package.json"), "utf8"));
    expect(packageJson).toMatchObject({
      name: "demo-acme-widgets",
      private: true,
      scripts: { dev: "next dev" },
    });
  });

  it("writes a config skeleton that parses, carries the identity, and TODO-fences the sample beats", async () => {
    const repoRoot = await writeRepoFixture();
    const { appDir } = await runDemoCreate(
      { ...args, prospect: "Acme Widgets Inc", ctaUrl: "https://cal.com/someone" },
      { repoRoot },
    );
    const raw = JSON.parse(await readFile(path.join(appDir, "demo.config.json"), "utf8"));
    // The skeleton must still parse against the template's own schema.
    const config = parseDemoConfig(raw);
    expect(config).toMatchObject({
      id: "acme-widgets",
      prospect: "Acme Widgets Inc",
      ctaUrl: "https://cal.com/someone",
      caps: { maxTurns: 20, maxSpendUsd: 5 },
    });
    expect(config.beats.map((beat) => beat.key)).toEqual(["generate-ui", "take-action", "save-app"]);
    for (const beat of config.beats) {
      expect(beat.prompt).toMatch(/^TODO\(creator\): /);
      expect(beat.chip).toMatch(/^TODO\(creator\): /);
    }
    // The verification declarations are the contract, not placeholders.
    expect(config.beats[0]?.expectsView).toBe(true);
    expect(config.beats[1]?.expectsApproval).toBe(true);
  });

  it("leaves a RESEARCH stub that records the prospect site and points at demo:research", async () => {
    const repoRoot = await writeRepoFixture();
    const { appDir } = await runDemoCreate({ ...args, url: "https://acme.example/pricing" }, { repoRoot });
    const stub = await readFile(path.join(appDir, "RESEARCH", "README.md"), "utf8");
    expect(stub).toContain("demo:research");
    expect(stub).toContain("--app apps/demo-acme-widgets");
    expect(stub).toContain("https://acme.example/pricing");
  });

  it("refuses an id that fails the demo.config slug rule, before touching disk", async () => {
    const repoRoot = await writeRepoFixture();
    await expect(runDemoCreate({ ...args, id: "Acme Widgets" }, { repoRoot }))
      .rejects.toThrow(/id: must be lowercase alphanumeric with hyphens/);
    expect(existsSync(path.join(repoRoot, "apps", "demo-Acme Widgets"))).toBe(false);
  });

  it("refuses to overwrite an existing target directory", async () => {
    const repoRoot = await writeRepoFixture();
    await mkdir(path.join(repoRoot, "apps", "demo-acme-widgets"), { recursive: true });
    await expect(runDemoCreate(args, { repoRoot }))
      .rejects.toThrow(/Refusing to overwrite/);
  });

  it("refuses to run when the template app is missing", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "vendo-demo-create-empty-"));
    await expect(runDemoCreate(args, { repoRoot }))
      .rejects.toThrow(/apps\/demo-template/);
  });
});
