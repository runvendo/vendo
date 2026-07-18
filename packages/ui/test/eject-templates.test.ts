/**
 * Eject templates — the published package ships the chrome presentation
 * sources for ejectable surfaces (§4 customization ladder: eject rung).
 * Assembled into dist/eject-templates at build; `vendo eject` copies them
 * into the host. These tests pin:
 *   - assembly output (files + generated header + manifest)
 *   - the build-time guard: templates import nothing package-internal that
 *     isn't publicly exported (the eject copy must compile against
 *     @vendoai/ui public surfaces only)
 *   - pack-and-inspect (packaging.e2e precedent): the tarball carries the
 *     templates and the runtime export map is untouched by template shipping
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORK_DIR = join(PACKAGE_DIR, ".e2e-eject-pack");

const lib = () => import("../scripts/eject-templates-lib.mjs");

afterAll(() => {
  rmSync(WORK_DIR, { recursive: true, force: true });
});

describe("eject template assembly", () => {
  it("assembles the thread surface into dist with a generated header and manifest", async () => {
    const { assembleEjectTemplates } = await lib();
    const manifest = await assembleEjectTemplates(PACKAGE_DIR);

    const version = (JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      version: string;
    }).version;
    expect(manifest.version).toBe(version);
    expect(Object.keys(manifest.surfaces)).toContain("thread");

    const surfaceDir = join(PACKAGE_DIR, "dist", "eject-templates", "thread");
    const files = manifest.surfaces.thread.files;
    // Lane A's per-piece split: ejection lands as a tidy directory, not one file.
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files).toContain("index.tsx");
    for (const file of files) {
      const source = readFileSync(join(surfaceDir, file), "utf8");
      expect(source, `${file} missing generated header`).toMatch(
        new RegExp(`Ejected from @vendoai/ui v${version.replaceAll(".", "\\.")}`),
      );
      expect(source, `${file} missing ownership line`).toContain("yours to edit");
    }
    // The written manifest is what the CLI reads to --list surfaces.
    const written = JSON.parse(
      readFileSync(join(PACKAGE_DIR, "dist", "eject-templates", "templates.json"), "utf8"),
    ) as typeof manifest;
    expect(written.surfaces.thread.files).toEqual(files);
  });

  it("ships the activities surface: the single VendoActivities file as index.tsx", async () => {
    const { assembleEjectTemplates } = await lib();
    const manifest = await assembleEjectTemplates(PACKAGE_DIR);

    const activities = manifest.surfaces.activities;
    expect(activities.files).toEqual(["index.tsx"]);
    expect(activities.component).toBe("VendoActivities");
    // The CLI resolves this surface's relative imports against chrome/, so a
    // "./activity-semantics.js" sibling import rewrites to @vendoai/ui/chrome.
    expect(activities.sourceBase).toBe("chrome");
    expect(activities.sourceDir).toBeUndefined();
    // thread keeps its own directory: intra-surface imports stay relative.
    expect(manifest.surfaces.thread.sourceBase).toBe("chrome/thread");
    expect(manifest.surfaces.thread.sourceDir).toBe("chrome/thread");
    expect(manifest.surfaces.thread.component).toBe("VendoThread");

    const source = readFileSync(
      join(PACKAGE_DIR, "dist", "eject-templates", "activities", "index.tsx"),
      "utf8",
    );
    expect(source).toContain("yours to edit");
    expect(source).toContain("export function VendoActivities");
  });

  it("rejects a template importing a package internal that is not publicly exported", async () => {
    const { checkTemplateSource, publicSurfaces } = await lib();
    const surfaces = await publicSurfaces(PACKAGE_DIR);
    const errors = checkTemplateSource(
      "thread/evil.tsx",
      'import { definitelyNotExported } from "../dev-mode.js";\n',
      surfaces,
      { sourceBase: "chrome/thread", sourceDir: "chrome/thread" },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("definitelyNotExported");
    expect(errors[0]).toContain("thread/evil.tsx");
  });

  it("accepts imports of publicly exported symbols and intra-surface relative imports", async () => {
    const { checkTemplateSource, publicSurfaces } = await lib();
    const surfaces = await publicSurfaces(PACKAGE_DIR);
    // Specifiers are concatenated so the repo dependency-guard (which greps
    // raw file text for import-shaped strings) doesn't read fixture data as
    // real escaping imports.
    const errors = checkTemplateSource(
      "thread/fine.tsx",
      [
        'import { ApprovalCard } from ' + '"../approval-card.js";',
        'import { useVendoThread } from ' + '"../../hooks/use-vendo-thread.js";',
        'import { PayloadView } from ' + '"../../tree/renderer.js";',
        'import { Composer } from "./composer.js";',
        'import { useState } from "react";',
        "",
      ].join("\n"),
      surfaces,
      { sourceBase: "chrome/thread", sourceDir: "chrome/thread" },
    );
    expect(errors).toEqual([]);
  });

  it("rejects escaping side-effect and dynamic imports (unverifiable, unrewritable)", async () => {
    const { checkTemplateSource, publicSurfaces } = await lib();
    const surfaces = await publicSurfaces(PACKAGE_DIR);
    const shape = { sourceBase: "chrome/thread", sourceDir: "chrome/thread" };
    const sideEffect = checkTemplateSource(
      "thread/evil.tsx",
      'import ' + '"../chrome-css.js";\n',
      surfaces,
      shape,
    );
    expect(sideEffect).toHaveLength(1);
    expect(sideEffect[0]).toContain("side-effect");
    const dynamic = checkTemplateSource(
      "thread/evil.tsx",
      'const x = await import(' + '"../build-beat.js");\n',
      surfaces,
      shape,
    );
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0]).toContain("dynamic");
    // Intra-surface forms of both stay allowed.
    expect(checkTemplateSource(
      "thread/fine.tsx",
      'import "./chrome-effects.js";\nconst p = await import("./parts.js");\n',
      surfaces,
      shape,
    )).toEqual([]);
  });

  it("resolves a chrome-root surface's sibling imports against the chrome surface", async () => {
    const { checkTemplateSource, publicSurfaces } = await lib();
    const surfaces = await publicSurfaces(PACKAGE_DIR);
    // For a single-file surface living in chrome/ itself, "./sibling.js" is a
    // chrome-internal import (must be publicly exported), and "../hooks/…" is
    // a root import — different from the thread's directory-relative shape.
    const errors = checkTemplateSource(
      "activities/index.tsx",
      [
        'import { ApprovalCard } from "./approval-card.js";',
        'import { useActivity } from "../hooks/use-activity.js";',
        'import { secretInternal } from "./dev-mode.js";',
        "",
      ].join("\n"),
      surfaces,
      { sourceBase: "chrome" },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("secretInternal");
  });
});

describe("eject templates pack-and-inspect", () => {
  it("packed tarball ships the templates; runtime export map and files are untouched", async () => {
    const { assembleEjectTemplates } = await lib();
    await assembleEjectTemplates(PACKAGE_DIR);

    rmSync(WORK_DIR, { recursive: true, force: true });
    mkdirSync(WORK_DIR, { recursive: true });
    execFileSync("pnpm", ["pack", "--pack-destination", WORK_DIR], {
      cwd: PACKAGE_DIR,
      stdio: "pipe",
    });
    const tarball = readdirSync(WORK_DIR).find((name) => name.endsWith(".tgz"));
    if (tarball === undefined) throw new Error("pnpm pack produced no tarball");
    execFileSync("tar", ["-xzf", join(WORK_DIR, tarball), "-C", WORK_DIR], { stdio: "pipe" });
    const packedDir = join(WORK_DIR, "package");

    const manifest = JSON.parse(
      readFileSync(join(packedDir, "dist", "eject-templates", "templates.json"), "utf8"),
    ) as { surfaces: Record<string, { files: string[] }> };
    for (const file of manifest.surfaces.thread!.files) {
      expect(existsSync(join(packedDir, "dist", "eject-templates", "thread", file))).toBe(true);
    }

    // Template shipping must not alter the package's runtime export surface.
    const packageJson = JSON.parse(readFileSync(join(packedDir, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
      files: string[];
    };
    expect(Object.keys(packageJson.exports)).toEqual([".", "./chrome", "./tree", "./voice"]);
    expect(packageJson.files).toEqual(["dist", "README.md"]);
  }, 60_000);
});
