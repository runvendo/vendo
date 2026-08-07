import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

/**
 * A scratch directory that is removed when the test finishes — pass, fail, or
 * throw.
 *
 * The harness's fixtures used to `mkdtemp` and never remove, which is why a
 * green run still grew /tmp: the removal has to be registered at the moment the
 * directory exists, not written at the end of the test body where a failing
 * assertion skips it. `onTestFinished` is registered here, one statement after
 * the `mkdtemp`, and vitest runs those hooks outside the test body's own
 * try/catch — so a rejected expectation, a thrown fixture, or a hook that
 * already failed cannot strand the directory. Each hook is also isolated from
 * the others, so one failing removal does not abandon the rest.
 *
 * Must be called from inside a test (`onTestFinished` needs a live test
 * context). For a directory built in `beforeAll`, remove it in `afterAll`
 * instead — vitest runs `afterAll` even when `beforeAll` threw.
 */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
