/**
 * The shell, inside a host process that watches its own promises.
 *
 * just-bash's MAIN-THREAD defense box patches host globals for the duration of a
 * command. A host that has installed an async-hooks `init` callback — Next dev's
 * React async tracker is the one that bit us — sees that callback fire on the
 * box's own first promise, inside the box, where `performance.now()` and
 * `new WeakRef()` are guarded. The box throws, and it throws from
 * `emitInitNative`, which Node treats as unrecoverable: no try/catch of ours is
 * even on the stack. The host's dev server died on the FIRST bash call, every
 * time, and the engine's own tests could not see it because a test runner
 * installs no such hook.
 *
 * So this runs the built shell in a subprocess that installs one, and asserts
 * the process lives. In a subprocess because the failure mode being pinned is
 * `process._fatalException` — in-process it would take the vitest worker with
 * it, which is a crashed run rather than a red test.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHELL_DIST = join(PACKAGE_DIR, "dist", "vendo", "shell");

/** Next's dev tracker, reduced to the one object literal its crash stacks point
 *  at (next-server/app-page-turbo.runtime.dev.js): a `performance.now()`, a
 *  `WeakRef` on the resource, and a captured stack. */
const PROBE = `
import { createHook } from "node:async_hooks";
import { InMemoryFs } from "just-bash";
import { createShellSession } from "./engine.js";

let inits = 0;
createHook({
  init(_id, _type, _trigger, resource) {
    inits += 1;
    void {
      start: globalThis.performance.now(),
      promise: new WeakRef(resource),
      stack: new Error().stack,
    };
  },
}).enable();

const workspace = new InMemoryFs();
await workspace.mkdir("/user/files", { recursive: true });
await workspace.writeFile("/user/files/rows.txt", "a\\nb\\nc\\n");

const session = createShellSession({ workspace, javascript: true });
const bash = await session.exec("wc -l < files/rows.txt");
const jsExec = await session.exec("js-exec -c 'console.log(6 * 7)'");
// A SECOND session in the same process: just-bash's defense box is a process
// singleton that refuses two Bash instances whose resolved config differs, down
// to the identity of the onViolation callback.
const second = await createShellSession({ workspace }).exec("echo second-session");

process.stdout.write(JSON.stringify({ inits, bash, jsExec, second }));
// js-exec parks its QuickJS worker for the next call; a probe that has said
// everything it has to say exits rather than waiting for it.
process.exit(0);
`;

let probe: { status: number | null; stdout: string; stderr: string };
let out: {
  inits: number;
  bash: { stdout: string; exitCode: number };
  jsExec: { stdout: string; exitCode: number };
  second: { stdout: string; exitCode: number };
};

/** Written INTO the built dist, so its bare imports resolve the way a host's
 *  would; removed after, so the build output is left as tsc emitted it. */
const SCRIPT = join(SHELL_DIST, "async-hooks-probe.mjs");

afterAll(async () => { await rm(SCRIPT, { force: true }); });

beforeAll(async () => {
  // The built dist is what a host actually loads, and it is what `pnpm build`
  // emits — same command, so this never tests a stale copy.
  execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: PACKAGE_DIR, stdio: "pipe" });
  await writeFile(SCRIPT, PROBE);
  probe = spawnSync(process.execPath, [SCRIPT], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  out = probe.status === 0 ? JSON.parse(probe.stdout) as typeof out : ({} as typeof out);
}, 300_000);

describe("the shell under a host's async-hooks init callback", () => {
  it("leaves the host process alive", () => {
    // The whole defect, in one assertion: this exited 9 short of `status === 0`
    // with `SecurityViolationError: globalThis.performance.now is blocked`.
    expect({ status: probe.status, fatal: /SecurityViolationError/.test(probe.stderr) })
      .toEqual({ status: 0, fatal: false });
  });

  it("ran every command, with the host's hook firing throughout", () => {
    expect(out.bash).toMatchObject({ stdout: "3\n", exitCode: 0 });
    expect(out.jsExec).toMatchObject({ stdout: "42\n", exitCode: 0 });
    expect(out.inits).toBeGreaterThan(100);
  });

  it("lets a second session run in the same process", () => {
    expect(out.second).toMatchObject({ stdout: "second-session\n", exitCode: 0 });
  });

  it("tells the operator once per violation type, not once per violation", () => {
    // ~1294 violations in one measured turn: a line each is a line per promise.
    // The count is the assertion — the audit is only useful if it is readable.
    const lines = probe.stderr.split("\n").filter((line) => line.includes("[vendo] shell:"));
    expect(lines.length).toBeGreaterThan(0);
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines.join("\n")).toContain("performance_timing");
    expect(lines.join("\n")).toContain("ALLOWED");
  });
});
