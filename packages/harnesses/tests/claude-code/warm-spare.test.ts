/**
 * A warm turn's box is parked as a SPARE rather than under the throwaway thread
 * id it was booted for — and a spare nobody claims must still go.
 *
 * The claim itself is proven at the seam it spans, in
 * `packages/vendo/tests/warm-spare.test.ts`: the real warm door minting the id and
 * the real pool reading it, with only the SandboxAdapter faked. What lives HERE is
 * the one rule that seam cannot reach, because no wire exposes the idle budget: a
 * spare is a real cloud machine, so if it were exempt from the idle sweep the warm
 * door would leak a billed box per process instead of per call — a worse bug than
 * the one this whole change fixes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WARM_THREAD_PREFIX } from "@vendoai/core";
import { afterEach, expect, test } from "vitest";
// The REAL box door, over a fake transport: `hello` is a protocol, and a fake that
// simply says yes to it is how a live blocker hid once already.
import { createSessionRoutes } from "../../box/turn-routes.mjs";
import { boxMachine, disposeSessionMachines, type SandboxAdapterLike } from "../../src/claude-code/box.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const boxRoots: string[] = [];
afterEach(async () => {
  await disposeSessionMachines();
  for (const root of boxRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeSandbox(): SandboxAdapterLike & { destroyed: boolean[] } {
  const destroyed: boolean[] = [];
  return {
    destroyed,
    async create() {
      const root = mkdtempSync(path.join(tmpdir(), "vendo-spare-unit-"));
      boxRoots.push(root);
      const at = destroyed.push(false) - 1;
      const routes = createSessionRoutes({ root, token: "", env: {} }) as {
        handle: (method: string, pathname: string, headers: Record<string, string>, payload: unknown)
          => Promise<{ status: number; body: unknown }>;
      };
      return {
        id: `box_${at}`,
        files: {
          read: async () => new Uint8Array(),
          write: async () => undefined,
          list: async () => [],
        },
        url: async () => `https://box-${at}.fake-provider.test`,
        async request(req) {
          const payload = req.body === undefined
            ? {}
            : JSON.parse(typeof req.body === "string" ? req.body : decoder.decode(req.body)) as unknown;
          const answer = await routes.handle(req.method, req.path, req.headers ?? {}, payload);
          return { status: answer.status, headers: {}, body: encoder.encode(JSON.stringify(answer.body)) };
        },
        async destroy() { destroyed[at] = true; },
      };
    },
    async destroy() { /* no machine to reap by ref */ },
  };
}

test("a spare no conversation ever claims is destroyed on the same idle budget as a thread's box", async () => {
  const sandbox = fakeSandbox();
  const spare = await boxMachine({
    sandbox,
    threadId: `${WARM_THREAD_PREFIX}abc123`,
    env: {},
    allowedDomains: [],
    idleTtlMs: 5,
  });
  await spare.release();
  await new Promise((resolve) => setTimeout(resolve, 60));

  expect(sandbox.destroyed).toEqual([true]);
});
