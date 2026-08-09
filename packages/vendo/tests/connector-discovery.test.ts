import { VENDO_TOOL_TITLES, type RunContext, type ToolOutcome } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import {
  CONNECTOR_DISCOVERY_TOOLS,
  connectorDiscoveryRegistry,
  type ConnectorDiscoveryPorts,
  type ServiceToolMatch,
} from "../src/connector-discovery.js";

const ctx = (overrides: Partial<RunContext> = {}): RunContext => ({
  principal: { kind: "user", subject: "user_alice" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
  ...overrides,
});

const call = (tool: string, args: unknown) => ({ id: "call_1", tool, args: args as never });

const MATCH: ServiceToolMatch = {
  slug: "SLACK_SEND_MESSAGE",
  toolkit: "slack",
  description: "Post a message to a Slack channel",
  inputSchema: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] },
  connected: false,
  statusMessage: "Connect Slack to use this tool.",
};

const ports = (overrides: Partial<ConnectorDiscoveryPorts> = {}): ConnectorDiscoveryPorts => ({
  find: async () => [MATCH],
  use: async () => ({ status: "ok", output: { ok: true } }),
  list: async () => [{ toolkit: "gmail", label: "Gmail", connected: true }],
  connect: async (toolkit) => (toolkit === "gmail" ? { connector: "composio", toolkit: "gmail" } : undefined),
  ...overrides,
});

describe("the connector-discovery tools are ordinary tools on the one registry", () => {
  it("projects exactly the contracted tool set", async () => {
    const descriptors = await connectorDiscoveryRegistry(ports()).descriptors();
    expect(descriptors.map((d) => d.name).sort()).toEqual([...CONNECTOR_DISCOVERY_TOOLS].sort());
  });

  it("grades the two lookups `read` and the dispatcher `ungraded`", async () => {
    // The dispatcher's descriptor CANNOT carry a real grade: one tool name stands
    // in for a whole third-party catalog. `ungraded` is ask-by-default (#747), and
    // the broker's per-slug grade arrives through the guard's resolveRisk hook.
    const byName = new Map((await connectorDiscoveryRegistry(ports()).descriptors()).map((d) => [d.name, d.risk]));
    expect(byName.get("find_service_tools")).toBe("read");
    expect(byName.get("list_connections")).toBe("read");
    expect(byName.get("use_service_tool")).toBe("ungraded");
    // Asking is a read: the tool changes nothing — the PERSON decides on the card.
    expect(byName.get("request_connection")).toBe("read");
  });

  /** uiaudit 2026-08-06 — the description used to scope the tool to "INSTEAD of a
   *  service tool you already know is unconnected", and the zero-key Cloud default
   *  projects NO service tools at all: a literal reading made the tool inapplicable
   *  to the one deployment that has nothing else. The condition is the REQUEST's. */
  it("scopes request_connection to the request, not to what is on the listing", async () => {
    const byName = new Map((await connectorDiscoveryRegistry(ports()).descriptors()).map((d) => [d.name, d.description]));
    const ask = byName.get("request_connection")!;
    expect(ask).toContain("whenever the request needs a service that is not connected");
    expect(ask).toContain("whether or not you can see that service's tools");
    expect(ask).not.toContain("INSTEAD of a service tool you already know is unconnected");
  });

  it("reads each title from core's one table, and none of them is an identifier", async () => {
    const descriptors = await connectorDiscoveryRegistry(ports()).descriptors();
    expect(descriptors.map((d) => d.title)).toEqual([
      VENDO_TOOL_TITLES.find_service_tools,
      VENDO_TOOL_TITLES.use_service_tool,
      VENDO_TOOL_TITLES.list_connections,
      VENDO_TOOL_TITLES.request_connection,
    ]);
    for (const descriptor of descriptors) {
      expect(descriptor.title, descriptor.name).toBeTruthy();
      expect(descriptor.title, descriptor.name).not.toContain("_");
    }
  });
});

describe("find_service_tools", () => {
  it("hands the need and the CALLER's ctx to the broker and returns each match inline", async () => {
    const seen: Array<[string, string]> = [];
    const registry = connectorDiscoveryRegistry(ports({
      find: async (need, findCtx) => {
        seen.push([need, findCtx.principal.subject]);
        return [MATCH];
      },
    }));

    const outcome = await registry.execute(call("find_service_tools", { need: "  post to slack  " }), ctx());

    // A connection belongs to a person: the port never assembles its own ctx.
    expect(seen).toEqual([["post to slack", "user_alice"]]);
    // The whole reason the listing never changes: everything needed to CALL the
    // tool — slug and full argument schema — comes back with the match, so
    // finding costs one round trip and no re-list.
    expect(outcome).toEqual({
      status: "ok",
      output: {
        tools: [{
          slug: "SLACK_SEND_MESSAGE",
          toolkit: "slack",
          description: "Post a message to a Slack channel",
          connected: false,
          statusMessage: "Connect Slack to use this tool.",
          inputSchema: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] },
        }],
      },
    });
  });

  it("MARKS a match the broker could not produce a schema for", async () => {
    // An absent `inputSchema` field reads as "takes no arguments" and the model
    // then calls the tool with `{}`. It has to be told to ask instead.
    const { inputSchema: _dropped, ...noSchema } = MATCH;
    const outcome = await connectorDiscoveryRegistry(ports({ find: async () => [noSchema] }))
      .execute(call("find_service_tools", { need: "post to slack" }), ctx());

    const [row] = (outcome as { output: { tools: Array<Record<string, unknown>> } }).output.tools;
    expect(row).not.toHaveProperty("inputSchema");
    expect(row!["schemaUnavailable"]).toMatch(/do not guess arguments/i);
  });

  it("rejects a blank need rather than dumping the whole catalog", async () => {
    // The broker's catalog is 20,000+ tools. A model that can dump it stops
    // searching and starts guessing from the top of the list.
    const outcome = await connectorDiscoveryRegistry(ports()).execute(call("find_service_tools", { need: " " }), ctx());
    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
  });

  it("bounds the need at both ends — in the schema AND in execute", async () => {
    const [find] = await connectorDiscoveryRegistry(ports()).descriptors();
    const need = (find?.inputSchema as { properties?: { need?: Record<string, unknown> } }).properties?.need;
    expect(need).toMatchObject({ minLength: 1, maxLength: 512 });

    // A schema is advice to the model; execute is what makes it true. A whole
    // pasted document as a "need" is ranked against the broker's whole catalog
    // otherwise.
    let searched = false;
    const outcome = await connectorDiscoveryRegistry(ports({
      find: async () => { searched = true; return []; },
    })).execute(call("find_service_tools", { need: "x".repeat(513) }), ctx());

    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
    expect(searched).toBe(false);
  });

  it("accepts a need right at the bound", async () => {
    const outcome = await connectorDiscoveryRegistry(ports())
      .execute(call("find_service_tools", { need: "x".repeat(512) }), ctx());
    expect(outcome).toMatchObject({ status: "ok" });
  });
});

/**
 * The bound that keeps this tool's answer OUT of the bridge's truncation path.
 * The bridge slices a serialized result at a character count, so a search that
 * reaches the cap comes back with its last schema cut mid-object and nothing
 * saying which match lost it — while the model is told to call with the schema
 * that came back.
 */
describe("find_service_tools bounds its own answer by size", () => {
  /** The shipped `toolOutputCap` default. */
  const CAP = 32_000;
  const share = (cap: number) => Math.floor(cap * 0.9);

  /** A match at the size the real ones are. Measured against Composio's live
   *  catalog 2026-08-03: their email and Slack tools serialize to 0.8–5.5KB per
   *  match once their human-facing copy is trimmed, and eight of them to 24,736
   *  chars — against a 32,000 cap. A toy 200-byte schema would prove nothing
   *  about this bound, so the fixture is built to the measured size and the
   *  first test asserts it still is. */
  const brokerMatch = (slug: string, properties: number): ServiceToolMatch => ({
    slug,
    toolkit: "gmail",
    description: `Composio's own one-line description of ${slug}`,
    connected: true,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(Array.from({ length: properties }, (_, index) => [`field_${index}`, {
        type: "string",
        description:
          `Argument ${index}. Composio's parameter descriptions run a full paragraph: they restate the `
          + "constraint, name the sibling fields the value interacts with, spell out what happens when it "
          + "is left out, and give the format the provider's API expects down to the separator between "
          + "entries — which is why one of their tool schemas is kilobytes rather than bytes, why a match "
          + "is worthless without one, and why ten of them do not fit inside one tool result.",
      }])),
      required: ["field_0"],
    },
  });

  const found = async (matches: ServiceToolMatch[], toolOutputCap: number) => {
    const outcome = await connectorDiscoveryRegistry(ports({ find: async () => matches }), { toolOutputCap })
      .execute(call("find_service_tools", { need: "send an email to a contact" }), ctx());
    expect(outcome.status).toBe("ok");
    const output = (outcome as { output: Record<string, unknown> }).output;
    return { output, size: JSON.stringify(output).length, tools: output["tools"] as Array<Record<string, unknown>> };
  };

  it("returns a realistic multi-match answer WHOLE", async () => {
    // The measured live distribution: eight email matches, the biggest of them
    // ten paragraph-described arguments.
    const matches = [10, 9, 5, 10, 2, 8, 2, 3].map((properties, index) => brokerMatch(`GMAIL_TOOL_${index}`, properties));
    const { output, size, tools } = await found(matches, CAP);

    // The fixture is only worth what its size is: if these ever shrink to toys,
    // every assertion below stops meaning anything.
    expect(JSON.stringify(matches[0]).length).toBeGreaterThan(3_000);
    expect(JSON.stringify({ tools: matches }).length).toBeGreaterThan(20_000);

    expect(tools).toHaveLength(8);
    expect(tools.every((row) => row["inputSchema"] !== undefined)).toBe(true);
    // Nothing was dropped, so nothing is claimed to have been.
    expect(output).not.toHaveProperty("moreMatches");
    // And the bridge has nothing to cut: this is the exact string it measures.
    expect(size).toBeLessThanOrEqual(CAP);
  });

  it("drops the matches that do not fit and SAYS how many, rather than being cut mid-schema", async () => {
    const matches = Array.from({ length: 10 }, (_, index) => brokerMatch(`GMAIL_TOOL_${index}`, 10));
    const { output, size, tools } = await found(matches, CAP);

    expect(size).toBeLessThanOrEqual(share(CAP));
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBeLessThan(matches.length);
    // The whole point: the loss is visible and countable, and every row that DID
    // come back is a whole row.
    expect(output["moreMatches"]).toBe(matches.length - tools.length);
    expect(output["moreMatchesNote"]).toMatch(/narrower need/i);
    expect(tools.every((row) => typeof row["inputSchema"] === "object")).toBe(true);
    // Relevance order is the broker's, and it is kept: the dropped ones are the tail.
    expect(tools.map((row) => row["slug"])).toEqual(matches.slice(0, tools.length).map((match) => match.slug));
  });

  it("still returns a match whose OWN schema is bigger than the whole answer", async () => {
    const huge = brokerMatch("GMAIL_MONSTER", 200);
    expect(JSON.stringify(huge).length).toBeGreaterThan(CAP);
    const { size, tools } = await found([huge], CAP);

    // Returning nothing would be the same silence, one layer earlier. The row
    // comes back usable — slug, toolkit, connect status — with the schema marked
    // absent in the words the model already acts on.
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ slug: "GMAIL_MONSTER", toolkit: "gmail", connected: true });
    expect(tools[0]).not.toHaveProperty("inputSchema");
    expect(tools[0]!["schemaUnavailable"]).toMatch(/too large/i);
    expect(tools[0]!["schemaUnavailable"]).toMatch(/do not guess arguments/i);
    expect(size).toBeLessThanOrEqual(share(CAP));
  });

  it("bounds against the cap the COMPOSITION set, not a constant of its own", async () => {
    const matches = Array.from({ length: 10 }, (_, index) => brokerMatch(`GMAIL_TOOL_${index}`, 10));
    const small = await found(matches, 8_000);
    const large = await found(matches, CAP);

    expect(small.size).toBeLessThanOrEqual(share(8_000));
    expect(small.tools.length).toBeLessThan(large.tools.length);
  });
});

describe("use_service_tool", () => {
  it("dispatches the slug and arguments as the caller, and returns the outcome verbatim", async () => {
    const seen: Array<[string, unknown, string]> = [];
    // The passthrough the guard lifts onto the audit row. Rewrapping the outcome
    // here would drop it and the audit row would not name the toolkit.
    const dispatched: ToolOutcome = {
      status: "ok",
      output: { ts: "1712.0" },
      connectorAccount: { connector: "composio", toolkit: "slack" },
    } as ToolOutcome;
    const registry = connectorDiscoveryRegistry(ports({
      use: async (slug, args, useCtx) => {
        seen.push([slug, args, useCtx.principal.subject]);
        return dispatched;
      },
    }));

    const outcome = await registry.execute(
      call("use_service_tool", { slug: " SLACK_SEND_MESSAGE ", arguments: { channel: "#general" } }),
      ctx(),
    );

    expect(seen).toEqual([["SLACK_SEND_MESSAGE", { channel: "#general" }, "user_alice"]]);
    expect(outcome).toBe(dispatched);
  });

  it("treats a missing arguments object as no arguments", async () => {
    // Zero-parameter broker tools exist; requiring the key would make the model
    // invent one.
    const seen: unknown[] = [];
    await connectorDiscoveryRegistry(ports({
      use: async (_slug, args) => { seen.push(args); return { status: "ok", output: {} }; },
    })).execute(call("use_service_tool", { slug: "GMAIL_GET_PROFILE" }), ctx());
    expect(seen).toEqual([{}]);
  });

  it("refuses an unknown slug cleanly and sends the model back to search", async () => {
    // Never a throw, and never a "did you mean" — the broker's 404 carries no
    // suggestion list, so naming a near-miss would be an invention and the model
    // would work its way down a list of guesses.
    const outcome = await connectorDiscoveryRegistry(ports({ use: async () => undefined }))
      .execute(call("use_service_tool", { slug: "SLACK_SEND_MSG" }), ctx());

    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
    const message = (outcome as { error: { message: string } }).error.message;
    expect(message).toContain("SLACK_SEND_MSG");
    expect(message).toContain("find_service_tools");
    expect(message).not.toMatch(/did you mean/i);
  });

  it("rejects a blank slug before it reaches the broker", async () => {
    let dispatched = false;
    const outcome = await connectorDiscoveryRegistry(ports({
      use: async () => { dispatched = true; return { status: "ok", output: {} }; },
    })).execute(call("use_service_tool", { slug: "  " }), ctx());
    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
    expect(dispatched).toBe(false);
  });
});

describe("list_connections", () => {
  it("needs no input and reports each service's connect status", async () => {
    const outcome = await connectorDiscoveryRegistry(ports()).execute(call("list_connections", {}), ctx());
    expect(outcome).toEqual({
      status: "ok",
      output: { connections: [{ toolkit: "gmail", label: "Gmail", connected: true }] },
    });
  });
});

/** V5 — connecting stays a UI act, but the ASK is now a tool call: the agent
 *  raises the card in its own words BEFORE spending a call it knows will be
 *  refused. What comes back is the same `connect-required` outcome a refused
 *  service call produces, so nothing new reaches the wire or the renderer. */
describe("request_connection", () => {
  it("mints the connect-required outcome verbatim, carrying the model's own sentence", async () => {
    const seen: Array<[string, string]> = [];
    const registry = connectorDiscoveryRegistry(ports({
      connect: async (toolkit, connectCtx) => {
        seen.push([toolkit, connectCtx.principal.subject]);
        return { connector: "composio", toolkit };
      },
    }));

    const outcome = await registry.execute(
      call("request_connection", { toolkit: " gmail ", reason: "I need Gmail to draft your spending summary." }),
      ctx(),
    );

    // A connection belongs to a person: the port gets the CALLER's ctx.
    expect(seen).toEqual([["gmail", "user_alice"]]);
    // The EXISTING shape (01-core §4) — the reason becomes the card's message.
    expect(outcome).toEqual({
      status: "connect-required",
      connect: {
        connector: "composio",
        toolkit: "gmail",
        message: "I need Gmail to draft your spending summary.",
      },
    });
  });

  it("refuses a toolkit this deployment cannot connect instead of raising a dead button", async () => {
    const outcome = await connectorDiscoveryRegistry(ports())
      .execute(call("request_connection", { toolkit: "salesforce", reason: "To read your pipeline." }), ctx());

    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
    const message = (outcome as { error: { message: string } }).error.message;
    expect(message).toContain("salesforce");
    expect(message).toContain("list_connections");
  });

  it("rejects a blank toolkit and a blank reason before the port is reached", async () => {
    let asked = false;
    const registry = connectorDiscoveryRegistry(ports({
      connect: async () => { asked = true; return { connector: "composio", toolkit: "gmail" }; },
    }));
    for (const args of [{ toolkit: "  ", reason: "Because." }, { toolkit: "gmail", reason: "   " }]) {
      expect(await registry.execute(call("request_connection", args), ctx()))
        .toMatchObject({ status: "error", error: { code: "validation" } });
    }
    expect(asked).toBe(false);
  });

  it("refuses a reason longer than one sentence — the card is not a place for a rationale", async () => {
    // Same law as MAX_NEED_LENGTH: the schema is advice to the model, the
    // execute check is the enforcement. A person reads this on a card.
    const outcome = await connectorDiscoveryRegistry(ports())
      .execute(call("request_connection", { toolkit: "gmail", reason: "x".repeat(281) }), ctx());

    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
    expect((outcome as { error: { message: string } }).error.message).toContain("280");
    // The boundary itself is fine.
    expect(await connectorDiscoveryRegistry(ports())
      .execute(call("request_connection", { toolkit: "gmail", reason: "x".repeat(280) }), ctx()))
      .toMatchObject({ status: "connect-required" });
  });
});

describe("no adapter, no tool", () => {
  it("projects list_connections ALONE when nothing can search or dispatch", async () => {
    // The zero-key Cloud default connector's shape: connections, no catalog.
    // A search tool with nothing behind it is worse than no search tool.
    const descriptors = await connectorDiscoveryRegistry({ list: ports().list }).descriptors();
    expect(descriptors.map((d) => d.name)).toEqual(["list_connections"]);
  });

  it("answers a call for an unprojected tool the way it answers a name it never had", async () => {
    const registry = connectorDiscoveryRegistry({ list: ports().list });
    for (const tool of ["find_service_tools", "use_service_tool", "request_connection"]) {
      expect(await registry.execute(call(tool, { need: "x", slug: "x" }), ctx()), tool)
        .toMatchObject({ status: "error", error: { code: "not-found" } });
    }
  });

  it("refuses an unknown tool instead of silently succeeding", async () => {
    const outcome = await connectorDiscoveryRegistry(ports()).execute(call("connect_service", {}), ctx());
    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
  });
});

describe("a port failure is ours, not the model's", () => {
  it("does not leak raw JS error text when the search port throws", async () => {
    const outcome = await connectorDiscoveryRegistry(ports({
      find: async () => { throw new TypeError("Cannot read properties of undefined (reading 'toolkit')"); },
    })).execute(call("find_service_tools", { need: "email" }), ctx());

    expect(outcome.status).toBe("error");
    expect(JSON.stringify(outcome)).not.toContain("Cannot read properties");
    expect(JSON.stringify(outcome)).not.toContain("TypeError");
    expect(JSON.stringify(outcome)).toContain("find_service_tools");
  });

  it("turns a dispatch failure into an honest tool error without leaking the cause", async () => {
    const outcome = await connectorDiscoveryRegistry(ports({
      use: async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); },
    })).execute(call("use_service_tool", { slug: "SLACK_SEND_MESSAGE" }), ctx());
    expect(outcome.status).toBe("error");
    expect(JSON.stringify(outcome)).not.toContain("ECONNREFUSED");
  });

  it("turns a list-port failure into an honest tool error without leaking the cause", async () => {
    const outcome = await connectorDiscoveryRegistry(ports({
      list: async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); },
    })).execute(call("list_connections", {}), ctx());
    expect(outcome.status).toBe("error");
    expect(JSON.stringify(outcome)).not.toContain("ECONNREFUSED");
  });
});
