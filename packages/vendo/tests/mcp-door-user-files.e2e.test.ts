/**
 * THE SEAM the withheld drawer used to stand in for: an OUTSIDE agent putting
 * a user's file at the door, and reading it back.
 *
 * `compose-mcp.ts` used to hold `vendo_user_files_list`/`_read` back with
 * `withholdTools`, and a pin in `mcp-door-outside-agent.e2e.test.ts` guaranteed
 * that. Removing the fence removes that guarantee, so this file owes a real one
 * in its place — and a real one cannot be measured against a stub. Every
 * assertion here rides the STOCK `@modelcontextprotocol/sdk` client over the
 * composed umbrella's own `vendo.handler`: the real PKCE bearer, the real
 * JSON-RPC session, the real registry, the real workspace store. The write goes
 * in through the tool and comes back through the read tool, with nothing mocked
 * on either side — a harness that mocked the counterparty would let the two
 * disagree forever.
 *
 * The guard preset is `autopilot` because `vendo_user_files_put` is honestly
 * `risk: "write"` and `cautious` parks every write for a human tap
 * (`guard/src/policy.ts`). What is being measured here is the drawer, not the
 * approvals queue, and the parking behaviour is already pinned next door.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UPLOAD_HEADER } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, FILES_STORE_MAX_BYTES, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

const MOUNT = "https://host.test/api/vendo/mcp";
const REDIRECT = "https://client.example/callback";
const VERIFIER = "a-very-long-pkce-verifier-that-is-valid-for-the-files-seam-1234567890";

const ALICE = "user_alice";
const BOB = "user_bob";

const LEDGER = "date,amount,payee\n2026-08-01,12.50,Maple Coffee\n2026-08-02,4.00,Corner Store\n";
/** A real parquet's first four bytes, then bytes that are not text in any
 *  encoding — the point is that it STORES and refuses to be read as text. */
const PARQUET = new Uint8Array([0x50, 0x41, 0x52, 0x31, 0x00, 0xff, 0xfe, 0x01, 0x02, 0x03]);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Host {
  vendo: Vendo;
  /** Whose subject the NEXT `/authorize` mints a bearer for. */
  actAs(subject: string): void;
}

async function composedHost(options?: { uploadMaxBytes?: number }): Promise<Host> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-files-seam-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  let subject = ALICE;
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => ({ kind: "user", subject }),
    store,
    guard: { policy: "autopilot" },
    harness: defineHarness({
      name: "files-seam-probe",
      // eslint-disable-next-line require-yield
      async *run() {
        throw new Error("no turn runs in this file — the door is the whole subject");
      },
    }) as never,
    mcp: true,
    ...(options?.uploadMaxBytes === undefined ? {} : { uploadMaxBytes: options.uploadMaxBytes }),
    oauth: {
      async authorize() {
        return { subject };
      },
      async principal(who: string) {
        return { kind: "user", subject: who };
      },
    },
  } as Parameters<typeof createVendo>[0]);
  await store.ensureSchema();
  return { vendo, actAs: (who) => { subject = who; } };
}

/** register → authorize → token: the ONLY way an outside agent's bearer exists. */
async function bearer(vendo: Vendo): Promise<string> {
  const registered = await vendo.handler(new Request(`${MOUNT}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "files seam", redirect_uris: [REDIRECT], scope: "read write" }),
  }));
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const authorized = await vendo.handler(new Request(`${MOUNT}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
    code_challenge_method: "S256",
    scope: "read write",
    resource: MOUNT,
  })}`));
  const code = new URL(authorized.headers.get("location")!).searchParams.get("code")!;
  const issued = await vendo.handler(new Request(`${MOUNT}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
      code,
      client_id: clientId,
      code_verifier: VERIFIER,
      resource: MOUNT,
    }),
  }));
  if (issued.status !== 200) throw new Error(`token failed ${issued.status}: ${await issued.text()}`);
  return ((await issued.json()) as { access_token: string }).access_token;
}

interface Answer {
  isError: boolean;
  text: string;
  /** The tool's own JSON output, when the answer carries one. */
  json: Record<string, unknown>;
}

/** A STOCK MCP client, speaking to the composed door in-process: the transport
 *  is the SDK's real streamable-HTTP one, with only its `fetch` pointed at
 *  `vendo.handler` instead of the network. */
async function connect(vendo: Vendo, token: string): Promise<{
  listTools(): Promise<string[]>;
  call(name: string, args: Record<string, unknown>): Promise<Answer>;
}> {
  const transport = new StreamableHTTPClientTransport(new URL(MOUNT), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return vendo.handler(new Request(input, { ...init, headers } as RequestInit));
    },
  });
  const client = new Client({ name: "outside-files-agent", version: "1.0.0" });
  await client.connect(transport);
  cleanups.push(async () => {
    await client.close();
  });
  return {
    async listTools() {
      return (await client.listTools()).tools.map((tool) => tool.name);
    },
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const text = ((result.content ?? []) as Array<{ text?: string }>)
        .map((part) => part.text ?? "").join("");
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = {};
      }
      return { isError: result.isError === true, text, json };
    },
  };
}

const base64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

describe("the user's files, at the MCP door", () => {
  it("OFFERS the drawer to an outside agent — all three hands", async () => {
    const host = await composedHost();
    const door = await connect(host.vendo, await bearer(host.vendo));

    const offered = await door.listTools();
    expect(offered).toContain("vendo_user_files_list");
    expect(offered).toContain("vendo_user_files_read");
    expect(offered).toContain("vendo_user_files_put");
  });

  it("a CSV goes IN through the door and comes back OUT of it, bytes intact", async () => {
    const host = await composedHost();
    const door = await connect(host.vendo, await bearer(host.vendo));

    const put = await door.call("vendo_user_files_put", { name: "ledger.csv", content: LEDGER });
    expect(put.isError, put.text).toBe(false);
    expect(put.json["path"]).toBe("/user/files/ledger.csv");
    expect(put.json["bytes"]).toBe(new TextEncoder().encode(LEDGER).byteLength);
    expect(put.json["mediaType"]).toBe("text/csv");

    // The REAL read path, over the same door — no stub between the two.
    const listed = await door.call("vendo_user_files_list", {});
    expect(listed.json["files"]).toEqual([
      { name: "ledger.csv", bytes: new TextEncoder().encode(LEDGER).byteLength, mediaType: "text/csv" },
    ]);

    const read = await door.call("vendo_user_files_read", { name: "ledger.csv" });
    expect(read.isError, read.text).toBe(false);
    expect(read.json["readable"]).toBeUndefined();
    // Byte-for-byte, minus the trailing newline `linesOf` drops by design.
    expect(read.json["content"]).toBe(LEDGER.trimEnd());
    expect(read.json["lines"]).toBe(3);
  });

  it("refuses an over-cap upload in the DROP DOOR's own words — one cap, one sentence", async () => {
    const host = await composedHost({ uploadMaxBytes: 64 });
    const door = await connect(host.vendo, await bearer(host.vendo));

    const big = "x".repeat(100);
    const refused = await door.call("vendo_user_files_put", { name: "big.csv", content: big });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(
      '"big.csv" is 100 bytes and the upload door allows at most 64: send a smaller file,'
      + " or raise createVendo({ uploadMaxBytes }). These bytes land in this deployment's store,"
      + ` which caps one file at ${FILES_STORE_MAX_BYTES} bytes`
      + " — wire createVendo({ files }) with a FilesAdapter (s3Files) before raising the door past it.",
    );

    // …and the SAME sentence out of P2's drop door, so the two can never drift.
    const dropped = await host.vendo.handler(new Request("https://host.test/api/vendo/files?name=big.csv", {
      method: "POST",
      headers: { [UPLOAD_HEADER]: "1", "content-type": "text/csv" },
      body: big,
    }));
    const { error } = (await dropped.json()) as { error?: { message?: string } };
    expect(refused.text).toContain(error?.message);

    // Refused means REFUSED: nothing landed.
    const listed = await door.call("vendo_user_files_list", {});
    expect(listed.json["files"]).toEqual([]);
  });

  it("STORES a parquet and answers honestly about reading it, naming what does read back", async () => {
    const host = await composedHost();
    const door = await connect(host.vendo, await bearer(host.vendo));

    const put = await door.call("vendo_user_files_put", {
      name: "sales.parquet",
      content: base64(PARQUET),
      encoding: "base64",
    });
    expect(put.isError, put.text).toBe(false);
    expect(put.json["bytes"]).toBe(PARQUET.byteLength);

    // Stored: it is in the drawer, at its real size.
    const listed = await door.call("vendo_user_files_list", {});
    expect(listed.json["files"]).toEqual([
      { name: "sales.parquet", bytes: PARQUET.byteLength, mediaType: "application/octet-stream" },
    ]);

    const read = await door.call("vendo_user_files_read", { name: "sales.parquet" });
    expect(read.isError, read.text).toBe(false);
    expect(read.json["readable"]).toBe(false);
    expect(read.json["content"]).toBeUndefined();
    expect(read.json["reason"]).toBe(
      "sales.parquet is saved, but its contents cannot be read back yet."
      + " Only these read back as text: csv, tsv, txt, log, sql, md, json, ndjson, xml, html, yaml, yml."
      + " Tell the user what the file is and ask them for one of those if you need what is inside it.",
    );
  });

  it("keeps one user's drawer out of another's session", async () => {
    const host = await composedHost();
    const alice = await connect(host.vendo, await bearer(host.vendo));
    await alice.call("vendo_user_files_put", { name: "secret.csv", content: LEDGER });

    host.actAs(BOB);
    const bob = await connect(host.vendo, await bearer(host.vendo));

    // Bob authenticated fine and holds the same tools — and sees an empty drawer.
    expect(await bob.listTools()).toContain("vendo_user_files_read");
    expect((await bob.call("vendo_user_files_list", {})).json["files"]).toEqual([]);

    const stolen = await bob.call("vendo_user_files_read", { name: "secret.csv" });
    expect(stolen.isError).toBe(true);
    expect(stolen.text).toContain("is not one of this user's files");
    expect(stolen.text).not.toContain("Maple Coffee");

    // Bob's own write lands in BOB's drawer and leaves Alice's alone.
    await bob.call("vendo_user_files_put", { name: "bob.csv", content: "a,b\n1,2\n" });
    expect((await bob.call("vendo_user_files_list", {})).json["files"])
      .toEqual([{ name: "bob.csv", bytes: 8, mediaType: "text/csv" }]);
    expect((await alice.call("vendo_user_files_list", {})).json["files"])
      .toEqual([{ name: "secret.csv", bytes: new TextEncoder().encode(LEDGER).byteLength, mediaType: "text/csv" }]);
  });
});
