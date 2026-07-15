import { describe, expect, it } from "vitest";
import { TOOL_NAME_PATTERN, toolDescriptorSchema, type RunContext } from "@vendoai/core";
import { composioConnector } from "./composio.js";

const apiKey = process.env.COMPOSIO_API_KEY;

/** The entity a live happy-path execution rides: the workspace's own demo
 * user, which historically holds an ACTIVE googlecalendar connection. The
 * execute test self-skips when no active account exists. */
const DEMO_ENTITY = "flowlet-demo";
const LIVE_SUBJECT = "vendo-live-connections-test";

const ctxFor = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: "session_live",
});

// Live connector smoke — descriptor listing, the connections surface, and a
// read-only execution. CI runs the deterministic stub suites; this runs once
// wherever COMPOSIO_API_KEY is provided. The initiate/disconnect round trip
// only creates an INITIATED account (nobody completes the OAuth redirect) and
// deletes it again, so it leaves no standing state behind.
describe.skipIf(!apiKey)("composioConnector live (COMPOSIO_API_KEY-gated)", () => {
  it("lists real gmail descriptors through the frozen shape with curated risk", async () => {
    const connector = composioConnector({ apiKey: apiKey!, apps: ["gmail"] });
    const descriptors = await connector.descriptors();
    expect(descriptors.length).toBeGreaterThan(0);
    for (const descriptor of descriptors) {
      expect(toolDescriptorSchema.safeParse(descriptor).success).toBe(true);
      expect(descriptor.name).toMatch(TOOL_NAME_PATTERN);
      expect(["read", "write", "destructive"]).toContain(descriptor.risk);
    }
    // The curated map, against live metadata: fetch reads, delete asks.
    const fetchEmails = descriptors.find((descriptor) => descriptor.name === "gmail_GMAIL_FETCH_EMAILS");
    expect(fetchEmails?.risk).toBe("read");
    const deleteMessage = descriptors.find((descriptor) => descriptor.name === "gmail_GMAIL_DELETE_MESSAGE");
    if (deleteMessage) expect(deleteMessage.risk).toBe("destructive");
    // The old blanket default is gone: not everything is write.
    expect(new Set(descriptors.map((descriptor) => descriptor.risk)).size).toBeGreaterThan(1);
  }, 60_000);

  it("initiates a real connection (redirect URL), scopes it per subject, and disconnects it", async () => {
    const connector = composioConnector({ apiKey: apiKey! });
    const connections = connector.connections!;
    const initiated = await connections.initiate(LIVE_SUBJECT, "gmail");
    try {
      expect(initiated.redirectUrl).toMatch(/^https:\/\//);
      expect(initiated.id.length).toBeGreaterThan(0);

      const own = await connections.status(LIVE_SUBJECT, initiated.id);
      expect(own?.toolkit).toBe("gmail");
      expect(own?.status).toBe("initiated");

      // Per-principal isolation against the LIVE service: another subject
      // cannot observe this account, and cannot sever it.
      expect(await connections.status(`${LIVE_SUBJECT}-other`, initiated.id)).toBeNull();
      await expect(connections.disconnect(`${LIVE_SUBJECT}-other`, initiated.id)).rejects.toThrow(/not found/i);
      expect(await connections.status(LIVE_SUBJECT, initiated.id)).not.toBeNull();
    } finally {
      await connections.disconnect(LIVE_SUBJECT, initiated.id);
    }
    expect(await connections.status(LIVE_SUBJECT, initiated.id)).toBeNull();
  }, 120_000);

  it("returns a typed connect-required outcome for a user with no connection", async () => {
    const connector = composioConnector({ apiKey: apiKey!, apps: ["gmail"] });
    await connector.descriptors();
    const outcome = await connector.execute(
      { id: "call_live_missing", tool: "gmail_GMAIL_FETCH_EMAILS", args: {} },
      ctxFor("vendo-live-no-such-user"),
    );
    expect(outcome).toMatchObject({
      status: "connect-required",
      connect: { connector: "composio", toolkit: "gmail" },
      connectorAccount: { connector: "composio", toolkit: "gmail", entityId: "vendo-live-no-such-user" },
    });
  }, 60_000);

  it("executes a read-only call through an ACTIVE connected account (skips without one)", async (test) => {
    const connector = composioConnector({ apiKey: apiKey!, apps: ["googlecalendar"] });
    const accounts = await connector.connections!.list(DEMO_ENTITY);
    const active = accounts.find(
      (account) => account.toolkit === "googlecalendar" && account.status === "active",
    );
    if (!active) return test.skip();

    await connector.descriptors();
    const outcome = await connector.execute(
      { id: "call_live_ok", tool: "googlecalendar_GOOGLECALENDAR_LIST_CALENDARS", args: {} },
      ctxFor(DEMO_ENTITY),
    );
    expect(outcome).toMatchObject({
      status: "ok",
      connectorAccount: { connector: "composio", toolkit: "googlecalendar", entityId: DEMO_ENTITY },
    });
  }, 120_000);
});
