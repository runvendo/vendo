import { CONNECTOR_DISCOVERY_TOOLS, VENDO_TOOL_TITLES, type Json, type RunContext, type ToolDescriptor, type ToolOutcome, type ToolRegistry } from "@vendoai/core";

/**
 * The connector-discovery tools, projected as ordinary tools on the one registry
 * — so the guard, the audit trail and every door treat them exactly like a host
 * tool. There is no privileged side door.
 *
 * The tool LISTING never changes (connector-discovery design 2026-08-03). A
 * broker's catalog is tens of thousands of tools and no client re-lists mid
 * session, so the catalog is not reached by growing the list: `find_service_tools`
 * returns each match WITH its argument schema, and `use_service_tool` runs one by
 * the broker's own slug. These four names are permanent, and a tool the model
 * found a moment ago is callable on the same turn.
 *
 * CONNECTING is still a UI act — only the person can complete a consent screen,
 * and the connect card is where they do it. What `request_connection` changes is
 * WHO STARTS IT: the agent may now ASK, in its own words, as soon as it knows the
 * request needs a service this user has not connected — with or without that
 * service's tools on its listing. The tool mints exactly the `connect-required`
 * outcome a refused call would have produced, so the card the user sees is the
 * same card — it just no longer costs a failed call to reach.
 *
 * The four names themselves live in core: the loadout reads them too, and none of
 * them carries the `vendo_*` prefix its always-active exemption keys on.
 */
export { CONNECTOR_DISCOVERY_TOOLS };

/** The one dispatcher's name. Exported because composition has to recognise it
 *  to resolve the call's REAL, per-slug risk — see `serviceToolRisk` in the
 *  umbrella's server.ts. */
export const USE_SERVICE_TOOL = "use_service_tool";

/** A need is a phrase ("post a message to slack"), never a document.
 *  Declared in the schema AND enforced in `execute`, for the same reason the
 *  blank-input check is: a schema is advice to the model, and the broker behind
 *  this ranks the phrase against its whole catalog. */
const MAX_NEED_LENGTH = 512;

/** A reason is one sentence a PERSON reads on the connect card, never a
 *  rationale. Same law as {@link MAX_NEED_LENGTH}: declared in the schema AND
 *  enforced in `execute`, because a schema is advice to the model. */
const MAX_REASON_LENGTH = 280;

/** The share of the turn's tool-output cap one search may spend.
 *
 *  `find_service_tools` is the one tool whose result routinely approaches the
 *  cap: a broker's schemas run 5–7KB each (measured against Composio's live
 *  catalog 2026-08-03 — eight email matches serialized to 36,407 chars against a
 *  32,000 cap), and a match without its schema is half a match. The cap's own
 *  enforcement slices the SERIALIZED result at a character count, so a result
 *  that reaches it comes back with its last schema cut mid-object, with nothing
 *  saying which match lost it — and the model is told to call with the schema
 *  that came back. So this tool bounds ITSELF, in whole matches, and says what
 *  it dropped. The 10% is headroom between the measurement here and the one the
 *  bridge makes on the same object downstream. */
const OUTPUT_BUDGET_SHARE = 0.9;

/** Assumed when the composition does not say what the cap is. The shipped
 *  default is 32,000, but a host may set its own lower, and a bound that guesses
 *  high is no bound: guessing low costs a dropped match the model is TOLD about,
 *  guessing high costs the silent mid-schema cut this exists to prevent. */
const ASSUMED_TOOL_OUTPUT_CAP = 16_000;

const NO_SCHEMA_FROM_BROKER =
  "No argument schema came back for this tool. Ask the user what it needs — do not guess arguments.";
const SCHEMA_TOO_LARGE =
  "This tool's argument schema is too large to return here. Ask the user what it needs — do not guess arguments.";

/** One tool the broker's own search matched. Structurally identical to
 *  `ServiceToolMatch` in @vendoai/actions, restated here because agent may not
 *  depend on actions (layering) — the wire adapts one to the other. */
export interface ServiceToolMatch {
  /** The broker's callable slug, verbatim — what `use_service_tool` takes. */
  slug: string;
  toolkit: string;
  description: string;
  /** JSON Schema for `arguments`. Absent when the broker produced none. */
  inputSchema?: Record<string, unknown>;
  /** Whether THIS caller has an active connection for the toolkit. */
  connected: boolean;
  /** The broker's own sentence about the connection and what to do next. */
  statusMessage?: string;
}

export interface ConnectorDiscoveryPorts {
  /** The broker's OWN search over its whole catalog. Absent when no configured
   *  connector can search — no adapter, no tool, so `find_service_tools` is not
   *  projected at all rather than answering nothing.
   *
   *  `ctx` is the CALLER's, handed down from `execute` — never assembled by the
   *  port and never taken from the model's input, because a connection belongs
   *  to a person, not to the deployment. */
  find?(need: string, ctx: RunContext): Promise<ServiceToolMatch[]>;
  /** Run one of the broker's tools by its own slug, as the caller in `ctx`.
   *  `undefined` means NO connector serves that slug — the model gets a sentence
   *  telling it to search rather than guess a second slug. The outcome is
   *  returned verbatim so its `connectorAccount` passthrough reaches the guard's
   *  audit lift. Paired with {@link find}: both or neither. */
  use?(slug: string, args: unknown, ctx: RunContext): Promise<ToolOutcome | undefined>;
  /** The services this deployment can connect to, each tagged with whether the
   *  caller has connected it. Subject-scoped through `ctx` for the same reason. */
  list(ctx: RunContext): Promise<Json>;
  /** Resolve a toolkit slug to the connector that can connect it here, so the
   *  ask the model raises names a real, connectable service. `undefined` means
   *  THIS deployment cannot connect that toolkit — the model is told to check
   *  what exists rather than raise a card for a service nobody can complete.
   *  Absent (like {@link find}) means no connect is offered at all, so
   *  `request_connection` is not projected. */
  connect?(toolkit: string, ctx: RunContext): Promise<{ connector: string; toolkit: string } | undefined>;
}

/** Hand-written and reviewed in this repo; the declared label is final. */
const DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "find_service_tools",
    title: VENDO_TOOL_TITLES.find_service_tools,
    description:
      "Search outside services (email, calendars, SaaS) for a tool that does what you need. "
      + "Each match comes back with the exact slug to pass to use_service_tool, its argument schema, "
      + "and whether this user has connected that service yet.",
    inputSchema: {
      type: "object",
      properties: {
        need: { type: "string", minLength: 1, maxLength: MAX_NEED_LENGTH },
      },
      required: ["need"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: USE_SERVICE_TOOL,
    title: VENDO_TOOL_TITLES.use_service_tool,
    description:
      "Run one outside-service tool. Pass the slug exactly as find_service_tools returned it, "
      + "and arguments matching the schema that came back with it. "
      + "Never guess a slug and never invent arguments — search first.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", minLength: 1 },
        arguments: { type: "object" },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    // ONE tool name stands in for a whole third-party catalog, so the descriptor
    // cannot carry a real grade: `ungraded` is ask-by-default (#747), and the
    // per-slug grade the broker actually assigned arrives through the guard's
    // `resolveRisk` hook at call time.
    risk: "ungraded",
  },
  {
    name: "list_connections",
    title: VENDO_TOOL_TITLES.list_connections,
    description:
      "List the outside services this product can connect to and whether this user has connected each. "
      + "A service the user has not connected cannot run: ask for it with request_connection instead of calling it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  {
    name: "request_connection",
    title: VENDO_TOOL_TITLES.request_connection,
    // "INSTEAD of a service tool you already know is unconnected" scoped this tool
    // to a situation the shipped demo cannot reach (uiaudit 2026-08-06): the
    // zero-key Cloud default projects NO service tools, so a literal reading made
    // the tool inapplicable to the only deployment that needs it most. The
    // condition is the REQUEST's, not the listing's.
    description:
      "Ask the user to connect an outside service, and stop there. Call this whenever the request needs a "
      + "service that is not connected — whether or not you can see that service's tools. Never call a tool "
      + "of an unconnected service to see what happens, and never substitute a different service. "
      + "Pass the toolkit slug exactly as find_service_tools or list_connections "
      + "reported it, and one plain sentence saying why you need it, in the user's words. "
      + "The user gets a connect button; wait for them.",
    inputSchema: {
      type: "object",
      properties: {
        toolkit: { type: "string", minLength: 1 },
        reason: { type: "string", minLength: 1, maxLength: MAX_REASON_LENGTH },
      },
      required: ["toolkit", "reason"],
      additionalProperties: false,
    },
    risk: "read",
  },
];

/** Which port each tool needs. A tool whose port is unset is never projected —
 *  the repo's "no adapter, no tool" rule, applied per tool rather than per
 *  registry, because `list_connections` answers a standalone question that
 *  works on a connector with no search behind it. */
const PORT_FOR: Record<string, keyof ConnectorDiscoveryPorts> = {
  find_service_tools: "find",
  use_service_tool: "use",
  list_connections: "list",
  request_connection: "connect",
};

const fail = (code: string, message: string) => ({ status: "error" as const, error: { code, message } });
const notOurs = (tool: string) => fail("not-found", `${tool} is not a connector-discovery tool`);

export function connectorDiscoveryRegistry(
  ports: ConnectorDiscoveryPorts,
  /** The turn's `toolOutputCap`, so a search can stay under it instead of being
   *  cut by it. See {@link OUTPUT_BUDGET_SHARE}. */
  options: { toolOutputCap?: number } = {},
): ToolRegistry {
  const available = DESCRIPTORS.filter((descriptor) => ports[PORT_FOR[descriptor.name]!] !== undefined);
  const budget = Math.floor((options.toolOutputCap ?? ASSUMED_TOOL_OUTPUT_CAP) * OUTPUT_BUDGET_SHARE);

  return {
    async descriptors() {
      return available;
    },

    async execute(call, ctx: RunContext) {
      const args = (call.args ?? {}) as Record<string, unknown>;
      try {
        switch (call.tool) {
          case "find_service_tools": {
            // A tool whose port is unset was never projected, so a call naming
            // it is a call for a tool this registry does not have.
            const find = ports.find;
            if (find === undefined) return notOurs(call.tool);
            const need = typeof args["need"] === "string" ? args["need"].trim() : "";
            if (need === "") {
              return fail("validation", "find_service_tools needs a short phrase saying what you want to do — it never lists the whole catalog");
            }
            if (need.length > MAX_NEED_LENGTH) {
              return fail("validation", `find_service_tools takes a short intent, not a document — keep it under ${MAX_NEED_LENGTH} characters (this one was ${need.length})`);
            }
            const matches = await find(need, ctx);
            return { status: "ok", output: searchResult(matches, budget) as unknown as Json };
          }
          case USE_SERVICE_TOOL: {
            const use = ports.use;
            if (use === undefined) return notOurs(call.tool);
            const slug = typeof args["slug"] === "string" ? args["slug"].trim() : "";
            if (slug === "") {
              return fail("validation", "use_service_tool needs the slug find_service_tools returned");
            }
            const outcome = await use(slug, args["arguments"] ?? {}, ctx);
            // No connector serves this slug. Naming a near-miss would be an
            // invention — the broker's 404 carries no suggestions — so the only
            // honest next step is to search again.
            return outcome ?? fail("not-found", `No outside-service tool is called "${slug}". Call find_service_tools to get the real slug instead of trying another one.`);
          }
          case "list_connections": {
            const connections = await ports.list(ctx);
            return { status: "ok", output: { connections } as unknown as Json };
          }
          case "request_connection": {
            const requestConnect = ports.connect;
            if (requestConnect === undefined) return notOurs(call.tool);
            const toolkit = typeof args["toolkit"] === "string" ? args["toolkit"].trim() : "";
            if (toolkit === "") {
              return fail("validation", "request_connection needs the toolkit slug of the service to connect");
            }
            const reason = typeof args["reason"] === "string" ? args["reason"].trim() : "";
            if (reason === "") {
              return fail("validation", "request_connection needs one plain sentence saying why the user should connect it");
            }
            if (reason.length > MAX_REASON_LENGTH) {
              return fail("validation", `request_connection takes one sentence the user reads on the connect card, not a paragraph — keep it under ${MAX_REASON_LENGTH} characters (this one was ${reason.length})`);
            }
            const target = await requestConnect(toolkit, ctx);
            // Nothing here can connect that toolkit, so raising a card would
            // put a button in front of the user that cannot succeed.
            if (target === undefined) {
              return fail("not-found", `Nothing here can connect "${toolkit}". Call list_connections to see which services this product can connect.`);
            }
            return {
              status: "connect-required",
              connect: { connector: target.connector, toolkit: target.toolkit, message: reason },
            };
          }
          default:
            return notOurs(call.tool);
        }
      } catch (error) {
        // A port failure is OURS, not the model's, and raw JS text teaches it
        // nothing it can act on while leaking our internals into the transcript.
        // Log the detail for us; hand the model a sentence about what to do.
        console.error(`[vendo] ${call.tool} failed:`, error);
        return fail("error", `${call.tool} could not complete. Try again, or continue without it.`);
      }
    },
  };
}

/** One match as the model reads it. A missing schema is MARKED rather than
 *  omitted quietly: an absent field reads as "no arguments" and the model then
 *  calls the tool with `{}`. `schemaUnavailable` overrides — the schema is being
 *  withheld for size, and the row still has to say so in the same words the
 *  model is already taught to act on (ask, never guess). */
function row(match: ServiceToolMatch, schemaUnavailable?: string): Record<string, unknown> {
  const withheld = schemaUnavailable ?? (match.inputSchema === undefined ? NO_SCHEMA_FROM_BROKER : undefined);
  return {
    slug: match.slug,
    toolkit: match.toolkit,
    description: match.description,
    connected: match.connected,
    ...(match.statusMessage === undefined ? {} : { statusMessage: match.statusMessage }),
    ...(withheld === undefined ? { inputSchema: match.inputSchema } : { schemaUnavailable: withheld }),
  };
}

/** What the model is told when matches were left out for size — a count it can
 *  reason about and the one action that helps. */
function droppedNotice(count: number): Record<string, unknown> {
  return {
    moreMatches: count,
    moreMatchesNote:
      `${count} further match${count === 1 ? "" : "es"} came back but ${count === 1 ? "was" : "were"} left out `
      + "to keep this answer small. If none of the tools above fit, search again with a narrower need — "
      + "name the service, or the exact action.",
  };
}

/** The matches, in the broker's relevance order, for as long as the SERIALIZED
 *  result stays inside `budget` — so this result never reaches the bridge's cap
 *  and can never be cut mid-schema. Dropping is visible: the model is told how
 *  many it did not see and what to do about it. */
function searchResult(matches: ServiceToolMatch[], budget: number): Record<string, unknown> {
  // Priced in from the first row, worst case: a row admitted only because
  // nothing had been dropped yet must not be what pushes the notice out.
  const reserved = JSON.stringify(droppedNotice(matches.length)).length;
  // `+ 1` is the comma this row costs inside the array.
  const cost = (entry: Record<string, unknown>) => JSON.stringify(entry).length + 1;
  const tools: Array<Record<string, unknown>> = [];
  let used = JSON.stringify({ tools: [] }).length + reserved;
  let dropped = 0;

  for (const [index, match] of matches.entries()) {
    const full = row(match);
    if (used + cost(full) <= budget) {
      tools.push(full);
      used += cost(full);
      continue;
    }
    // A single schema larger than the whole budget can never fit beside
    // anything, so waiting for room is waiting forever. The row is still worth
    // having without it — marked, which sends the model to ask.
    const marked = row(match, SCHEMA_TOO_LARGE);
    if (cost(full) > budget && used + cost(marked) <= budget) {
      tools.push(marked);
      used += cost(marked);
      continue;
    }
    dropped = matches.length - index;
    break;
  }

  return { tools, ...(dropped === 0 ? {} : droppedNotice(dropped)) };
}
