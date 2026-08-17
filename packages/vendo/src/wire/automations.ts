import type { RunStatus } from "@vendoai/automations";
import { VendoError } from "@vendoai/core";
import { json, route, string, type RouteEntry } from "./shared.js";

/** 07-automations / 09 §3 — the /automations wire area, one route per verb on
    `vendo.automations`. Deliberately NO create: the one create operation is
    internal, and the four authoring doors (`vendo_automate`, `vendo_make`'s
    sugar, the vendo.json fold-in, `agent.on`) are the way in. */
export const automationRoutes: RouteEntry[] = [
  route("GET", "/automations", async ({ url, deps, context }) => {
    // Deployment-wide, filtered by who owns it and which agent runs it. There
    // is no `app` filter: an automation carries no app reference at all — an
    // app page filters by resolving its own `automations` list instead.
    const filter = {
      ...(url.searchParams.get("owner") === null ? {} : { owner: url.searchParams.get("owner")! }),
      ...(url.searchParams.get("agent") === null ? {} : { agent: url.searchParams.get("agent")! }),
    };
    return json(await deps.automations.list(filter, await context("automation")));
  }),
  route("GET", "/automations/:id", async ({ deps, context, params }) => {
    const id = string(params["id"], "automation id");
    const record = await deps.automations.get(id, await context("automation"));
    if (record === null) throw new VendoError("not-found", `automation not found: ${id}`);
    return json(record);
  }),
  // Grouped like the /runs arm below: context resolves before the operation
  // check, and an unknown operation falls through to the table's not-found.
  route("POST", "/automations/:id/:op", async ({ deps, context, params }) => {
    const id = string(params["id"], "automation id");
    const ctx = await context("automation");
    const operation = params["op"];
    if (operation === "enable") return json(await deps.automations.enable(id, ctx));
    if (operation === "disable") {
      await deps.automations.disable(id, ctx);
      return json({});
    }
    if (operation === "dry-run") return json(await deps.automations.dryRun(id, ctx));
    return undefined;
  }),
];

/** 07-automations / 09 §3 — the /runs wire area, over the ONE run ledger:
    owner, agent and console views are all filters here. */
export const runRoutes: RouteEntry[] = [
  route("GET", "/runs", async ({ url, deps, context }) => {
    const status = url.searchParams.get("status") ?? undefined;
    const allowed: RunStatus[] = ["running", "ok", "error", "stopped"];
    if (status !== undefined && !allowed.includes(status as RunStatus)) {
      throw new VendoError("validation", `run status "${status}" is not one of ${allowed.join(", ")}`);
    }
    const filter = {
      ...(url.searchParams.get("automationId") === null ? {} : { automationId: url.searchParams.get("automationId")! }),
      ...(url.searchParams.get("owner") === null ? {} : { owner: url.searchParams.get("owner")! }),
      ...(url.searchParams.get("agent") === null ? {} : { agent: url.searchParams.get("agent")! }),
      ...(status === undefined ? {} : { status: status as RunStatus }),
      ...(url.searchParams.get("cursor") === null ? {} : { cursor: url.searchParams.get("cursor")! }),
    };
    return json(await deps.automations.runs.list(filter, await context("automation")));
  }),
  // Grouped like the old `head === "runs" && segments.length >= 2` arm: ANY
  // method/depth resolves context first; unmatched shapes fall through.
  route("*", "/runs/:runId/*", async ({ request, deps, context, params, segments }) => {
    const ctx = await context("automation");
    const runId = string(params["runId"], "run id");
    if (request.method === "GET" && segments.length === 2) {
      const run = await deps.automations.runs.get(runId, ctx);
      if (run === null) throw new VendoError("not-found", `run not found: ${runId}`);
      return json(run);
    }
    if (request.method === "POST" && segments[2] === "stop" && segments.length === 3) {
      await deps.automations.runs.stop(runId, ctx);
      return json({});
    }
    // The remedy behind a fail-loud run: a FRESH run of the same automation on
    // the same event, so the door hands back the new run's id.
    if (request.method === "POST" && segments[2] === "rerun" && segments.length === 3) {
      return json({ runId: await deps.automations.runs.rerun(runId, ctx) });
    }
    return undefined;
  }),
];
