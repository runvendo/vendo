/**
 * The jail runtime bundle is generated INTO the source tree (`prebuild` ->
 * scripts/build-jail-runtime.mjs) and gitignored, and dev-mode hosts resolve
 * @vendoai/ui from src/, not dist/ (examples/demo-bank/next.config.ts's
 * turbopack resolveAlias). So the generated file has to be a declared turbo
 * output: with `dist/**` alone, a cache hit replays the build's logs —
 * including "[ui] generated jail runtime" — without restoring the file, and a
 * fresh clone with a warm cache 500s on every page with
 * "Can't resolve './runtime-bundle.gen.js'" (#915).
 *
 * Asked of turbo itself rather than of turbo.json's text, so the pin holds
 * wherever the declaration lives (global `build`, `@vendoai/ui#build`, an
 * extended config).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = "src/tree/jail/runtime-bundle.gen.ts";

describe("jail runtime bundle is a cacheable build output", () => {
  it("is the path the generator writes", () => {
    const generator = readFileSync(join(PACKAGE_DIR, "scripts/build-jail-runtime.mjs"), "utf8");
    expect(generator).toContain(`"${GENERATED}"`);
  });

  it("is in the resolved turbo outputs for @vendoai/ui#build", () => {
    const dryRun = JSON.parse(
      execFileSync("pnpm", ["exec", "turbo", "run", "build", "--dry=json", "--filter=@vendoai/ui"], {
        cwd: PACKAGE_DIR,
        encoding: "utf8",
      }),
    ) as { tasks: { taskId: string; resolvedTaskDefinition: { outputs: string[] } }[] };
    const build = dryRun.tasks.find((task) => task.taskId === "@vendoai/ui#build");
    expect(build?.resolvedTaskDefinition.outputs).toEqual(expect.arrayContaining([GENERATED, "dist/**"]));
  });
});
