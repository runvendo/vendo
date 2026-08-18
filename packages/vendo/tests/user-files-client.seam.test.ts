/**
 * SEAM: the shipped client's `files.upload` against the shipped drop door.
 *
 * The sibling of `client-door.seam.test.ts`, for the route it predates. `ui`
 * is layered to `@vendoai/core` alone, so a ui test can only prove its half
 * against a fixture wire that also lives in ui — the producer and the consumer
 * each holding their own copy of the route table, unable to disagree. Here
 * nothing is stubbed on either side: the real `createVendoClient` builds the
 * request, the real `vendo.handler` answers it, and the bytes are read back out
 * of the real workspace store. `fetch` is the only double, and it is a wire.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { createVendoClient, type VendoClient } from "@vendoai/ui";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

const BASE = "https://maple.test/api/vendo";
const USER_HEADER = "x-seam-user";
const ADA: Principal = { kind: "user", subject: "user_ada" };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function seam(): Promise<{ client: VendoClient; vendo: Vendo }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-user-files-client-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await store.ensureSchema();
  const vendo = createVendo({
    principal: async request => {
      const subject = request.headers.get(USER_HEADER);
      return subject === null ? null : { kind: "user", subject };
    },
    store,
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : (input as { url: string }).url;
    return vendo.handler(new Request(url, init));
  }) as typeof fetch;
  cleanups.push(() => { globalThis.fetch = realFetch; });

  return { client: createVendoClient({ baseUrl: BASE, headers: { [USER_HEADER]: ADA.subject } }), vendo };
}

const csv = (text: string): File => new File([text], "sales 2026.csv", { type: "text/csv" });

describe("the shipped client's upload against the shipped door", () => {
  it("uploads a file and the door's workspace has it", async () => {
    const { client, vendo } = await seam();

    // A name with a space is the ordinary case, and it proves the client's
    // percent-encoding and the door's decoding agree on one filename.
    const saved = await client.files.upload(csv("month,revenue\njan,31000\n"));

    expect(saved).toEqual({ path: "/user/files/sales 2026.csv", bytes: 24 });
    const workspace = await vendo.harness.workspace(ADA);
    expect(await workspace.readFile(saved.path)).toBe("month,revenue\njan,31000\n");
  });

  it("surfaces the door's refusal as a typed validation error", async () => {
    const { client } = await seam();
    const named = new File(["x"], "../escape.csv", { type: "text/csv" });

    await expect(client.files.upload(named)).rejects.toMatchObject({ code: "validation" });
  });
});
