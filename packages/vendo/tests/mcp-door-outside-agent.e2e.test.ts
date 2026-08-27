/**
 * THE OUTSIDE-AGENT PIN — what a real external MCP client sees, and what the
 * door-ctx lane promised would not move.
 *
 * The door-ctx lane teaches the door to carry a live turn's accountability
 * context (venue, presence, the turn's own approval card, THE LAW's §12
 * withholding, the transcript mirror). Every one of those is ADDITIVE, for a
 * caller that legitimately has a turn. A client that came in the only way an
 * outside agent can — `/register` → `/authorize` → `/token`, PKCE, no turn —
 * must keep TODAY'S behavior exactly.
 *
 * So this file was written and run GREEN against the unmodified door FIRST, and
 * every assertion below is a measurement of that run, not a wish. If closing a
 * divergence for turn-bearing callers moves anything an outside agent can see,
 * it fails here.
 *
 * Read with `mcp-door-parity.e2e.test.ts` (the turn-bearing half) — both drive
 * the same composed host and the same minimal MCP client from
 * `mcp-door.test-util.ts`.
 */
import { sealBundleBlobs } from "@vendoai/apps";
import { VENDO_APP_FORMAT, vendoApprovalRefSchema, type AppDocument, type AppId } from "@vendoai/core";
import { storeFiles, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOUNT,
  READ_TOOL,
  SUBJECT,
  WRITE_TOOL,
  bearer,
  composedHost,
  openDoor,
  rowsAddedBy,
  runCleanups,
  shapeOf,
} from "../src/mcp-door.test-util.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  await runCleanups();
});

const rpcBody = (method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });

const INITIALIZE = rpcBody("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "outside", version: "1.0.0" },
});

/** One app row for the granted subject, written where every real one is written
 *  — so `apps.open` reads it back through its own schema and its own rules. */
const seedApp = async (store: VendoStore, doc: Omit<AppDocument, "format">): Promise<void> => {
  await store.records("vendo_apps").put({
    id: doc.id,
    data: { subject: SUBJECT, enabled: true, doc: { format: VENDO_APP_FORMAT, ...doc } },
    refs: { subject: SUBJECT },
  });
};

describe("the MCP door, as an OUTSIDE agent sees it — pinned before door-ctx", () => {
  it("lists the host's tools VERBATIM, plus the apps ride-alongs, with the risk annotations derived from ONE label", async () => {
    const { vendo } = await composedHost(async () => undefined);
    const door = await openDoor(vendo, await bearer(vendo));

    const listed = await door.listTools();
    const byName = new Map(listed.map((tool) => [tool.name, tool]));

    // The host's own two, described in the REGISTRY's words (10-mcp §2).
    expect(byName.get(READ_TOOL)?.description).toBe("Look something up for the signed-in customer");
    expect(byName.get(READ_TOOL)?.annotations).toEqual({
      title: "Look something up",
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(byName.get(WRITE_TOOL)?.annotations).toEqual({
      title: "Send a payment",
      readOnlyHint: false,
      destructiveHint: false,
    });
    // The WHOLE offered surface, measured. The host's two plus every runtime
    // tool the composed umbrella registers — the `vendo_*` namespace is never
    // curated away (10-mcp §2), and `ask_user`/`schedule`/`validate` are the
    // runtime's own. Pinned as a SET so closing a divergence cannot quietly add
    // or withhold one from an outside agent.
    expect([...byName.keys()].sort()).toEqual([
      "ask_user",
      "host_lookup",
      "host_pay",
      "schedule",
      "validate",
      "vendo_apps_call",
      "vendo_apps_data_delete",
      "vendo_apps_data_list",
      "vendo_apps_data_put",
      "vendo_apps_list",
      "vendo_apps_open",
      "vendo_apps_pin",
      "vendo_apps_reseed",
      "vendo_apps_unpin",
      // The authoring door for "do this on its own" — one of the four ways the
      // single internal create operation is reached, and the only one an outside
      // agent has.
      "vendo_automate",
      // The one-tool contract's whole point for MCP: an outside agent asks for a
      // screen through `vendo_make` and never has to decide "new or change?"
      // first. Losing it from this list is losing the front door.
      "vendo_make",
      // The read that keeps a `slot` argument honest: without it an outside
      // agent can only guess a slot id, and a guess lands nowhere.
      "vendo_slots_list",
      // The user's own drawer, at the door on purpose: an outside agent
      // connects AS the user, and putting their files where that agent can
      // reach them is the whole point of the door. The isolation that matters
      // is per-USER, not per-door, and it is pinned in
      // `mcp-door-user-files.e2e.test.ts`.
      "vendo_user_files_list",
      "vendo_user_files_put",
      "vendo_user_files_read",
    ]);
  });

  it("a READ the policy runs: ok · rule · present · mcp · the granted subject", async () => {
    const { vendo, store } = await composedHost(async () => undefined);
    const door = await openDoor(vendo, await bearer(vendo));

    const rows = await rowsAddedBy(store, READ_TOOL, async () => {
      const answered = await door.callTool(READ_TOOL, { query: "balance" });
      expect(answered.isError).toBeFalsy();
    });
    expect(rows).toHaveLength(1);
    expect(shapeOf(rows[0])).toEqual({
      outcome: "ok",
      decidedBy: "rule",
      presence: "present",
      venue: "mcp",
      subject: SUBJECT,
    });
  });

  it("a WRITE the policy parks: the IN-BAND 'resolve it there, then retry', and a pending-approval row", async () => {
    const { vendo, store } = await composedHost(async () => undefined);
    const door = await openDoor(vendo, await bearer(vendo));

    const rows = await rowsAddedBy(store, WRITE_TOOL, async () => {
      const answered = await door.callTool(WRITE_TOOL, { amount: 1400 });
      expect(answered.isError).toBe(true);
      // The exact sentence: an outside client has no stream to receive a card on,
      // so the door names the queue and asks for a retry. This is the behavior
      // the turn-bearing path REPLACES, and the one this path keeps.
      expect(answered.text).toContain("needs approval");
      expect(answered.text).toContain("retry");
      // ADDITIVE, beside the unchanged prose: the same `vendo/approval-ref@1`
      // the in-process tool pack mints, so an outside loop reads the parked id
      // off a typed field instead of regexing it out of that sentence. Parsed
      // through core's own schema — the reader's contract, not a shape copied
      // into this file.
      const ref = vendoApprovalRefSchema.parse(answered.structuredContent);
      expect(ref.summary).toBe(`Send a payment to a payee — ${WRITE_TOOL} {"amount":1400}`);
      // One id, two spellings of the same answer: the prose names what the
      // typed field carries.
      expect(answered.text).toContain(ref.approvalId);
    });
    expect(shapeOf(rows.at(-1))).toEqual({
      outcome: "pending-approval",
      decidedBy: "rule",
      presence: "present",
      venue: "mcp",
      subject: SUBJECT,
    });
  });

  it("an unknown tool answers in-band, never as a JSON-RPC protocol error", async () => {
    const { vendo } = await composedHost(async () => undefined);
    const door = await openDoor(vendo, await bearer(vendo));

    const answered = await door.callTool("host_not_a_tool", {});
    expect(answered.isError).toBe(true);
    expect(answered.text).toContain("not-found");
  });

  it("no bearer is a 401 carrying the protected-resource challenge", async () => {
    const { vendo } = await composedHost(async () => undefined);
    const bare = await vendo.handler(new Request(MOUNT, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: INITIALIZE,
    }));
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toContain("resource_metadata=");
    // No token was presented, so the challenge must NOT claim the token was bad.
    expect(bare.headers.get("www-authenticate")).not.toContain("invalid_token");
  });

  it("an invented bearer is a 401 — a grant only exists at the end of the PKCE flow", async () => {
    const { vendo } = await composedHost(async () => undefined);
    for (const invented of ["bxt_a-token-the-harness-minted", "vtk_looks-like-a-turn-credential", "totally-made-up"]) {
      const answered = await vendo.handler(new Request(MOUNT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${invented}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
        },
        body: INITIALIZE,
      }));
      expect(answered.status, invented).toBe(401);
      expect(answered.headers.get("www-authenticate"), invented).toContain("invalid_token");
    }
  });

  it("a session id belongs to the grant that opened it — another client's bearer cannot drive it", async () => {
    const { vendo } = await composedHost(async () => undefined);
    const first = await bearer(vendo);

    // Open a session on the first grant and learn its id.
    const opened = await vendo.handler(new Request(MOUNT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${first}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: INITIALIZE,
    }));
    const sessionId = opened.headers.get("mcp-session-id");
    expect(sessionId).toMatch(/^mcps_/);

    // A SECOND registered client, same subject, its own grant. It may not reach
    // the first client's session.
    const second = await bearer(vendo);
    const stolen = await vendo.handler(new Request(MOUNT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${second}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": sessionId!,
      },
      body: rpcBody("tools/list"),
    }));
    expect(stolen.status).toBe(404);
  });

  /**
   * THE BUILT-APP WORLD (#1623), as the outside agent is told about it: an app
   * that is sealed, one waiting on its person, one still building, one dead.
   *
   * Every case below drives the REAL chain — a real seal, a real app row, the
   * real `apps.open`, the composed door's real apps port — because the whole
   * point is whether the producer and the projection agree about one app, and a
   * harness that answered for either of them could only agree with itself.
   */
  it("a SEALED bundle opens as a link-out card carrying the product name and where to open it", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://host.test");
    const { vendo, store } = await composedHost(async () => undefined);
    const app = "app_built" as AppId;
    // The same writer the build door lands a box's output through.
    const bundle = await sealBundleBlobs(
      app,
      [{ path: "dist/app.js", bytes: new TextEncoder().encode('document.title = "built";\n') }],
      "dist/app.js",
      storeFiles(store),
    );
    await seedApp(store, { id: app, name: "Built app", ui: "bundle", bundle });
    const door = await openDoor(vendo, await bearer(vendo));

    const opened = await door.callTool("vendo_apps_open", { appId: app });
    // The DEPLOYMENT's own public url: a sealed bundle boots inside the host's
    // own UI (a sandboxed frame on the host's postMessage bridge), so where the
    // person opens it is the product itself.
    expect(opened.isError, opened.text).toBeFalsy();
    expect(opened.structuredContent).toEqual({
      kind: "vendo/open-in-product@1",
      url: "https://host.test",
      appName: "Built app",
      productName: expect.any(String),
    });
    expect(opened.text).toMatch(/^Open Built app in .+: https:\/\/host\.test$/);
    // The entry hash — the one thing a bare passthrough gave an agent — is gone.
    expect(opened.text).not.toContain(bundle.entry);
  });

  it("an app waiting on its build approval is a NAMED wait, not a not-found error", async () => {
    const { vendo, store } = await composedHost(async () => undefined);
    const app = "app_proposed" as AppId;
    await seedApp(store, {
      id: app,
      name: "Proposed app",
      proposal: { approvalId: "apr_proposed", prompt: "my spending", why: "a screen was not enough", at: new Date().toISOString() },
    });
    const door = await openDoor(vendo, await bearer(vendo));

    const opened = await door.callTool("vendo_apps_open", { appId: app });
    // NOT an error: the person has been asked and has not answered. An agent
    // that reads this as a broken tool tells the user their app is gone.
    expect(opened.isError).toBeFalsy();
    expect(opened.text).toBe("This app is waiting on the user's build approval. Once they approve it, open it again.");
    expect(opened.structuredContent).toEqual({ kind: "pending", say: opened.text });
  });

  it("an app still being built says so, and says it as a wait", async () => {
    const { vendo, store } = await composedHost(async () => undefined);
    const app = "app_building" as AppId;
    await seedApp(store, { id: app, name: "Building app", building: new Date().toISOString() });
    const door = await openDoor(vendo, await bearer(vendo));

    const opened = await door.callTool("vendo_apps_open", { appId: app });
    expect(opened.isError).toBeFalsy();
    expect(opened.text).toBe("This app is still being built. Open it again in a moment.");
    expect(opened.structuredContent).toEqual({ kind: "pending", say: opened.text });
  });

  it("a build that failed for good comes back as its reason, not as a JSON record", async () => {
    const { vendo, store } = await composedHost(async () => undefined);
    const app = "app_failed" as AppId;
    await seedApp(store, {
      id: app,
      name: "Failed app",
      buildFailed: { reason: "The build ran out of time.", retryable: true, at: new Date().toISOString() },
    });
    const door = await openDoor(vendo, await bearer(vendo));

    const opened = await door.callTool("vendo_apps_open", { appId: app });
    expect(opened.isError).toBeFalsy();
    expect(opened.text).toBe("The build ran out of time. Asking for it again may work.");
    // The record still rides underneath, so a loop reads the kind rather than
    // the English.
    expect(opened.structuredContent).toMatchObject({ kind: "failed", reason: "The build ran out of time.", retryable: true });
  });
});
