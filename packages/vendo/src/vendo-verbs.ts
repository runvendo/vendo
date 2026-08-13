import { log, VENDO_TOOL_TITLES, VendoError, type Json, type RunContext, type ToolDescriptor, type ToolRegistry } from "@vendoai/core";

/**
 * Design §4's vendo-verb family, projected as ordinary tools on the one
 * registry — so the guard, the audit trail, and `find_tools` treat them exactly
 * like a host tool. There is no privileged side door.
 *
 * `records_list/put/delete` are deliberately NOT here: they already ship as
 * `vendo_apps_data_list/put/delete` (packages/apps/src/agent-tools.ts), already
 * guarded, and already referenced by name inside stored app documents and the
 * generation prompt. Renaming them would invalidate live documents for no
 * behavioural gain.
 */
export const VENDO_VERB_TOOLS = ["validate", "search_components", "schedule"] as const;

export interface VendoVerbFinding {
  severity: "block" | "warn";
  where?: string;
  message: string;
}

export interface VendoVerbPorts {
  /** Check a document against our catalog and the host's schemas. Returns
   *  findings; it does not throw on a bad document.
   *
   *  `ctx` is the CALLER's, handed down from `execute` — never assembled by the
   *  port and never taken from the model's input. Both of the app-touching verbs
   *  are owner-scoped behind it, so a model naming someone else's appId gets a
   *  not-found rather than a look at their app. */
  validate(
    input: { appId?: string; document?: string },
    ctx: RunContext,
  ): Promise<{ ok: boolean; findings: VendoVerbFinding[] }>;
  /** Search the component catalog. Returns the SHIPPED catalog vocabulary
   *  (`{ component, description, props?, examples?, remixable? }`). No ctx: the
   *  catalog is the deployment's, identical for everyone. */
  searchComponents(query: string, limit?: number): Promise<Json>;
  /** Arm or change an app's schedule. Owner-scoped through `ctx`. */
  schedule(input: { appId: string; cron: string }, ctx: RunContext): Promise<Json>;
}

/** Every label here is hand-written and reviewed in this repo, and the
 *  declared label is final. */
const DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "validate",
    title: VENDO_TOOL_TITLES.validate,
    description:
      "Check an app document against the component catalog and the host's schemas: does it parse, do the "
      + "tools/components/fields/schedules it references exist, do the types fit. Returns findings to fix. "
      + "Use it after every edit — it is faster and surer than re-reading your own work.",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string", minLength: 1 },
        document: { type: "string" },
      },
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "search_components",
    title: VENDO_TOOL_TITLES.search_components,
    description:
      "Search the component catalog by intent to find what you can render. Returns each component's name, "
      + "description, and props. Use it instead of guessing a component name.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "schedule",
    title: VENDO_TOOL_TITLES.schedule,
    // A write, not a read: re-timing a schedule changes what happens later,
    // without a person present at the moment it fires. The wording is
    // load-bearing (field, linkwarden 2026-08-08): "Set … what you are arming"
    // taught calling agents a build-the-view-then-arm-it-here decomposition
    // this verb cannot serve — it only re-times, and the authoring door is
    // vendo_make with the schedule and the action in one request.
    description:
      "Change when an app's existing automation next runs, as a cron expression. It never creates one: an app "
      + "with no automation needs the automation built first — ask vendo_make, naming this app in `app`, with "
      + "the schedule and the action in one request. Changing a schedule changes what the app does unattended, "
      + "so say plainly what you are changing.",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string", minLength: 1 },
        cron: { type: "string", minLength: 1 },
      },
      required: ["appId", "cron"],
      additionalProperties: false,
    },
    risk: "write",
  },
];

const fail = (code: string, message: string) => ({ status: "error" as const, error: { code, message } });

/** Every verb is a read or a non-destructive write, so none is withheld from an
 *  unattended run — automations legitimately validate and schedule. The law
 *  filters destructive and external work, which this family has none of. */
export function vendoVerbsRegistry(ports: VendoVerbPorts): ToolRegistry {
  return {
    async descriptors() {
      return DESCRIPTORS;
    },

    async execute(call, ctx: RunContext) {
      const args = (call.args ?? {}) as Record<string, unknown>;
      try {
        switch (call.tool) {
          case "validate": {
            // Nothing to check is NOT a pass. Answering ok/no-findings for an
            // empty request told the model its app was fine when nothing had been
            // examined — the worst lie a checker can tell.
            const appId = typeof args["appId"] === "string" ? args["appId"] : undefined;
            const document = typeof args["document"] === "string" ? args["document"] : undefined;
            if (appId === undefined && document === undefined) {
              return fail("validation", "validate needs an appId or a document to check");
            }
            // A broken document comes back as FINDINGS, never as a tool error: an
            // error reads to the model as "the tool is broken", findings read as
            // "your document is wrong". Only the second one gets fixed.
            const result = await ports.validate({
              ...(appId === undefined ? {} : { appId }),
              ...(document === undefined ? {} : { document }),
            }, ctx);
            return { status: "ok", output: { ok: result.ok, findings: result.findings } as unknown as Json };
          }
          case "search_components": {
            const query = typeof args["query"] === "string" ? args["query"].trim() : "";
            if (query === "") {
              return fail("validation", "search_components needs a query — it never lists the whole catalog");
            }
            const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
            const components = await ports.searchComponents(query, limit);
            return { status: "ok", output: { components } as unknown as Json };
          }
          case "schedule": {
            const appId = typeof args["appId"] === "string" ? args["appId"] : "";
            const cron = typeof args["cron"] === "string" ? args["cron"] : "";
            if (appId === "" || cron === "") {
              return fail("validation", "schedule needs both an appId and a cron expression");
            }
            return { status: "ok", output: await ports.schedule({ appId, cron }, ctx) };
          }
          default:
            return fail("not-found", `${call.tool} is not a Vendo verb`);
        }
      } catch (error) {
        // A VendoError was authored FOR the model ("app X has no schedule to
        // change. Ask for the automation itself first…"). Masking it tells the
        // model to retry a call that can never succeed, so forward it verbatim.
        if (error instanceof VendoError) return fail(error.code, error.message);
        // Anything else is OURS, not the model's, and raw JS text ("Cannot read
        // properties of undefined") teaches it nothing it can act on while
        // leaking our internals into the transcript. Log the detail for us; hand
        // the model a sentence about what to do.
        log({
          code: "vendo.tool-call-failed",
          level: "error",
          message: `[vendo] ${call.tool} failed:`,
          data: { error },
        });
        return fail("error", `${call.tool} could not complete. Try again, or continue without it.`);
      }
    },
  };
}
