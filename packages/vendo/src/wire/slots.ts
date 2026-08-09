import { VendoError } from "@vendoai/core";
import { json, requestJson, route, string, type RouteEntry } from "./shared.js";

/** The slot REGISTRY — which slots this caller's surfaces mount, as opposed to
    which app sits in one (`/apps/placements`). A slot is a prop on a host's own
    component, so the server cannot know one exists until a page renders it: the
    surfaces report themselves in, and the read ages out whatever stopped being
    reported (`packages/apps/src/slots.ts`).

    Subject scoping happens through `context()` alone, exactly like
    `/connections`: no caller-supplied subject exists on this surface, and a
    request the host's resolver answers null for is refused there. */

/** ONE slot from the report body. Validated here — the one place a
    host-authored descriptor crosses into the runtime. */
const descriptor = (value: unknown): { id: string; label: string } => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VendoError("validation", "each slot must be an object");
  }
  const entry = value as Record<string, unknown>;
  return { id: string(entry["id"], "slot id"), label: string(entry["label"], "slot label") };
};

export const slotRoutes: RouteEntry[] = [
  // Batched on purpose: a page mounts every one of its slots in the same
  // render, so the whole page reports in ONE request rather than one per slot.
  route("POST", "/slots", async ({ request, deps, context }) => {
    const body = await requestJson(request);
    const reported = body["slots"];
    if (!Array.isArray(reported)) throw new VendoError("validation", "slots must be an array");
    const slots = reported.map(descriptor);
    const ctx = await context("app");
    await deps.apps.slots.report({ slots }, ctx);
    return json({});
  }),
  route("GET", "/slots", async ({ deps, context }) => {
    const ctx = await context("app");
    return json(await deps.apps.slots.list(ctx));
  }),
];
