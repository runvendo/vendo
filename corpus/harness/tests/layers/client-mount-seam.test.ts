import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { findClientMount, mountedChild } from "../../src/layers/structural.js";
import { pathExists } from "../../src/util.js";

// The BUILT CLI, resolved exactly as init-step.ts resolves it. Nothing here
// imports the product's rule: `clientRoot` sits in packages/vendo/src/cli and
// has no export path out of the package (the umbrella publishes ./server,
// ./react, ./extract and the auth presets), and reaching into another package's
// source is what scripts/dependency-guard.mjs exists to stop. So the seam is
// tested the way the corpus itself meets the product — as a subprocess.
const workspaceRoot = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const cliBin = path.join(workspaceRoot, "packages/vendo/bin/vendo.mjs");
const run = promisify(execFile);

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeHost(files: readonly string[]): Promise<string> {
  const repoDir = await mkdtemp(path.join(tmpdir(), "vendo-corpus-seam-"));
  tempRoots.push(repoDir);
  // A Next dependency is what sends doctor down the Next wiring path at all.
  await writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({ name: "seam-host", dependencies: { next: "15.0.0" } }, null, 2) + "\n",
  );
  for (const rel of files) {
    await mkdir(path.dirname(path.join(repoDir, rel)), { recursive: true });
    await writeFile(path.join(repoDir, rel), "export default function Noop() { return null; }\n");
  }
  return repoDir;
}

/** Where the product says the mount belongs, straight out of the built CLI:
 * doctor's wiring/next-root failure names the file and the exact expression to
 * wrap, and it gets both from `clientRoot` — init's own answer (init prints the
 * same file as its `File:` line). --json never starts a dev server. */
async function productMount(repoDir: string): Promise<string> {
  const { stdout } = await run(process.execPath, [cliBin, "doctor", repoDir, "--json"])
    .catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
  const report = JSON.parse(stdout) as { checks?: { id: string; message: string }[] };
  const message = report.checks?.find((check) => check.id === "wiring/next-root")?.message ?? "";
  const file = /In (.+?), paste:/.exec(message)?.[1];
  const children = /then wrap: <VendoProvider baseUrl="\/api\/vendo">(.+?)<\/VendoProvider>/.exec(message)?.[1];
  if (file === undefined || children === undefined) {
    throw new Error(`doctor's wiring/next-root check no longer names the client root — update this parser, not the harness:\n${message}`);
  }
  return `${file} ${children}`;
}

// Every host shape whose client root the corpus has to find, and the two
// tie-breaks the rule turns on.
const MATRIX: ReadonlyArray<{ name: string; files: string[]; expected: string }> = [
  { name: "root app layout", files: ["app/layout.tsx"], expected: "app/layout.tsx {children}" },
  { name: "src app layout", files: ["src/app/layout.tsx"], expected: "src/app/layout.tsx {children}" },
  { name: "nested i18n layout (nextcrm)", files: ["app/[locale]/layout.tsx"], expected: "app/[locale]/layout.tsx {children}" },
  { name: "shallowest wins over nested", files: ["app/layout.tsx", "app/[locale]/layout.tsx"], expected: "app/layout.tsx {children}" },
  { name: "lexicographic on a depth tie", files: ["app/[locale]/layout.tsx", "app/(shop)/layout.tsx"], expected: "app/(shop)/layout.tsx {children}" },
  { name: "src pages _app (teable)", files: ["src/pages/_app.tsx"], expected: "src/pages/_app.tsx <Component {...pageProps} />" },
  { name: "pages _app", files: ["pages/_app.tsx"], expected: "pages/_app.tsx <Component {...pageProps} />" },
  { name: "layout wins over a sibling pages router", files: ["src/app/layout.tsx", "src/pages/_app.tsx"], expected: "src/app/layout.tsx {children}" },
  { name: "no client root yet — the file init asks the host to create", files: [], expected: "app/layout.tsx {children}" },
];

/** SEAM TEST. `findClientMount` is the corpus's copy of the product's
 * `clientRoot` (packages/vendo/src/cli/shared.ts) — the file init's `File:`
 * line names and doctor grades. The two copies drifted twice, first on teable's
 * pages `_app` and then on nextcrm's nested `[locale]` layout, and each time the
 * corpus pasted nothing, scored a mount that was never there, and only said so
 * after a 23-minute sweep. This is the detector: any further move of the
 * product's rule fails HERE, in a second, against the real built CLI. */
describe("findClientMount agrees with the built CLI's client root", () => {
  it("names the same file and wraps the same expression on every host shape", async () => {
    expect(
      await pathExists(path.join(workspaceRoot, "packages/vendo/dist/cli.js")),
      "the vendo CLI is not built — run pnpm build (turbo runs test after ^build)",
    ).toBe(true);

    const rows = await Promise.all(MATRIX.map(async (shape) => {
      const repoDir = await makeHost(shape.files);
      const mount = await findClientMount(repoDir);
      return {
        name: shape.name,
        harness: `${mount.mountRel} ${mountedChild(mount)}`,
        product: await productMount(repoDir),
      };
    }));

    const harness = Object.fromEntries(rows.map((row) => [row.name, row.harness]));
    // Both directions: agreement with the product, and the documented answer —
    // without the second, a matrix that stopped resolving anything would agree
    // on nothing and still pass.
    expect(harness).toEqual(Object.fromEntries(rows.map((row) => [row.name, row.product])));
    expect(harness).toEqual(Object.fromEntries(MATRIX.map((shape) => [shape.name, shape.expected])));
  }, 60_000);
});
