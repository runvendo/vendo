/**
 * The shell, run from where the PRODUCT runs it.
 *
 * just-bash and the three parser libraries are dependencies of this package
 * alone, so pnpm keeps them in this package's own node_modules. Every other test
 * in this directory runs from inside this package, where a bare
 * `import("just-bash")` therefore resolves — which is precisely why they all
 * stayed green while the shell was dead in every real host: the shell's imports
 * are deliberately bundler-blind (see importShellLibrary), so a bundler emits
 * them into a chunk that sits in the HOST APP's directory, and Node resolves a
 * bare specifier relative to the importing FILE.
 *
 * So this runs the BUILT shell out of a directory that cannot see those
 * libraries, left exactly as Turbopack and webpack leave it: the code is
 * relocated, while `import.meta.url` still names the original module (Turbopack
 * emits `file://${resolveAbsolutePath("packages/harnesses/dist/…")}` for it;
 * webpack substitutes the module's own resource URL). Under a plain `node`
 * subprocess, never the test runner's module graph — vitest resolves against
 * this package's root, which would hand back the very illusion this test exists
 * to break. The first assertion is that a bare specifier really is dead there,
 * so this can never pass by accident.
 */
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHELL_DIST = join(PACKAGE_DIR, "dist", "vendo", "shell");
const LIBRARIES = ["just-bash", "unpdf", "@e965/xlsx", "fflate"];

/** The whole run, in the relocated chunk's own process. Every command is caught
 *  so a library that fails to load reports as a result instead of a dead pipe. */
const PROBE = (justBashUrl: string): string => `
import { createShellSession } from "./engine.js";

const bare = {};
for (const specifier of ${JSON.stringify(LIBRARIES)}) {
  try {
    await import(specifier);
    bare[specifier] = "resolved";
  } catch (error) {
    bare[specifier] = error.code ?? String(error);
  }
}

const { InMemoryFs } = await import(${JSON.stringify(justBashUrl)});
const workspace = new InMemoryFs();
await workspace.mkdir("/user/files", { recursive: true });
await workspace.writeFile("/user/files/notes.txt", "plain text, not a document\\n");
const session = createShellSession({ workspace, javascript: true });

const run = async (command) => {
  try {
    return await session.exec(command);
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
};

process.stdout.write(JSON.stringify({
  bare,
  bash: await run("echo shell-alive"),
  jsExec: await run("js-exec -c 'console.log(6 * 7)'"),
  pdftotext: await run("pdftotext files/notes.txt"),
  xlsx2csv: await run("xlsx2csv files/notes.txt"),
  docx2txt: await run("docx2txt files/notes.txt"),
}));
// js-exec leaves its QuickJS worker parked for the next call, so a probe that
// has said everything it has to say exits rather than waiting for it.
process.exit(0);
`;

type Result = { stdout?: string; stderr?: string; exitCode?: number; error?: string };

let probed: { bare: Record<string, string> } & Record<string, Result>;
/** A full copy of the shell dist per run, so it is removed rather than left
 *  in the OS temp directory. */
let chunk: string;

afterAll(async () => { await rm(chunk, { recursive: true, force: true }); });

beforeAll(async () => {
  // The built dist is what a host actually loads, and it is what tsc emits for
  // `pnpm build` — same command, so this never tests a stale copy.
  execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: PACKAGE_DIR, stdio: "pipe" });
  chunk = await mkdtemp(join(tmpdir(), "vendo-host-chunk-"));
  await cp(SHELL_DIST, chunk, { recursive: true });
  await writeFile(join(chunk, "package.json"), '{"type":"module"}\n');
  // A bundler INLINES an ordinary sibling like @vendoai/core into the chunk; the
  // four above are the only imports left bare, because they alone are
  // bundler-blind. Modelling core as bare too would fail this fixture for a
  // reason no host has. So the chunk gets core, and nothing else — the first
  // assertion below still proves the four are genuinely dead here.
  await mkdir(join(chunk, "node_modules", "@vendoai"), { recursive: true });
  await symlink(join(PACKAGE_DIR, "..", "core"), join(chunk, "node_modules", "@vendoai", "core"), "dir");
  const runtime = join(chunk, "runtime.js");
  await writeFile(runtime, (await readFile(runtime, "utf8")).replaceAll(
    "import.meta.url",
    JSON.stringify(pathToFileURL(join(SHELL_DIST, "runtime.js")).href),
  ));
  const justBash = execFileSync(
    process.execPath,
    ["-e", 'process.stdout.write(require.resolve("just-bash"))'],
    { cwd: PACKAGE_DIR, encoding: "utf8" },
  );
  await writeFile(join(chunk, "probe.mjs"), PROBE(pathToFileURL(justBash).href));
  probed = JSON.parse(execFileSync(process.execPath, [join(chunk, "probe.mjs")], {
    cwd: chunk,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })) as typeof probed;
}, 300_000);

describe("the shell's libraries, from a chunk in the host app's directory", () => {
  it("is a directory where every bare specifier is genuinely dead", () => {
    expect(probed.bare).toEqual(Object.fromEntries(
      LIBRARIES.map((specifier) => [specifier, "ERR_MODULE_NOT_FOUND"]),
    ));
  });

  it("runs bash there anyway", () => {
    expect(probed.bash).toMatchObject({ stdout: "shell-alive\n", exitCode: 0 });
  });

  // just-bash's ESM entry, specifically: its CJS bundle has no `import.meta.url`
  // to bootstrap the QuickJS worker from, so js-exec — and only js-exec — dies
  // with "Invalid URL" if the load ever picks up the require condition.
  it("runs js-exec there, so it is the ESM build that loaded", () => {
    expect(probed.jsExec).toMatchObject({ stdout: "42\n", exitCode: 0 });
  });

  // Wrong bytes on purpose: each parser's OWN refusal is the proof its library
  // loaded and ran. A library that never loaded takes the command down instead.
  it.each([
    ["pdftotext", "PDF"],
    ["xlsx2csv", "spreadsheet"],
    ["docx2txt", "Word document"],
  ])("loads %s's library there", (command, format) => {
    expect(probed[command]).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining(`${command}: files/notes.txt: not a readable ${format}`) as unknown as string,
    });
  });
});
