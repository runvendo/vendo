// 2026-08-02 remix final shape (lane W1b) — the wire leg of the fork's props
// seed: POST /apps/fork-pin { slot, props? } carries the wrapper's
// serializable live props at fork time; the route validates the shape and the
// runtime stores it as the pinned node's props (the dashboard seed).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinComponentName } from "@vendoai/apps";
import type { Principal } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "./server.js";

const principal: Principal = { kind: "user", subject: "user_fork_props" };

const originalCwd = process.cwd();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  process.chdir(originalCwd);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const request = (method: string, path: string, body?: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("POST /apps/fork-pin — the props seed (2026-08-02)", () => {
  it("passes serializable props through to the pinned node and rejects a malformed shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-fork-props-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const slot = "TopMerchants";
    await mkdir(join(root, ".vendo", "remixable"), { recursive: true });
    await writeFile(join(root, ".vendo", "remixable", `${slot}.json`), JSON.stringify({
      slot,
      source: "export default function TopMerchants() { return <p>merchants</p>; }\n",
      hash: "sha256:fork-props-baseline",
      exportable: false,
      capturedAt: "2026-08-02T00:00:00.000Z",
    }));
    const store = createStore({ dataDir: join(root, ".data") });
    cleanups.push(async () => store.close());
    await store.ensureSchema();
    process.chdir(root);

    // No model configured: the gesture fork is deterministic and must not need one.
    const vendo = createVendo({ principal: async () => principal, store, development: true });

    const props = { title: "Top merchants", rows: [{ merchant: "Blue Bottle", amountCents: 1250 }] };
    const forkResponse = await vendo.handler(request("POST", "/apps/fork-pin", { slot, props }));
    expect(forkResponse.status).toBe(200);
    const forked = await forkResponse.json();
    expect(forked.app.pins).toEqual([{ slot, base: "sha256:fork-props-baseline" }]);
    expect(forked.app.tree.nodes).toContainEqual(expect.objectContaining({
      component: pinComponentName(slot),
      source: "generated",
      props,
    }));

    // A non-object props payload is a loud validation error, not a silent drop.
    const malformed = await vendo.handler(request("POST", "/apps/fork-pin", { slot, props: "nope" }));
    expect(malformed.status).toBe(400);
    const failure = await malformed.json();
    expect(failure.error.code).toBe("validation");
  });
});
