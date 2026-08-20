import {
  SLOTS_REPORT_MAX,
  SLOT_DESCRIPTION_MAX_CHARS,
  SLOT_ID_MAX_CHARS,
  SLOT_LABEL_MAX_CHARS,
  VendoError,
} from "@vendoai/core";
import { json, requestJson, route, string, type RouteEntry } from "./shared.js";

/** The slot REGISTRY — which slots this caller's surfaces mount, as opposed to
    which app sits in one (`/apps/placements`). Two sources, merged on read
    (`packages/apps/src/slots.ts`): the surfaces report themselves in here and
    the read ages out whatever stopped being reported, while a slot the host
    DECLARED in `createVendo({ slots })` is always in the answer — it never
    decays, needs no render, and beats a report of the same id.

    Subject scoping happens through `context()` alone, exactly like
    `/connections`: no caller-supplied subject exists on this surface, and a
    request the host's resolver answers null for is refused there. */

/** Any page render writes here, so this is the widest unprivileged write on the
    wire and it is bounded like its neighbours (at most 200 tool names on
    /sync/impact, a 1-256 character row id on /box). The numbers live in
    @vendoai/core because the UI client cleans a page's report to fit them
    before it sends; this route is the strict backstop for every other caller,
    so the two must never drift. */
const bounded = (value: unknown, label: string, max: number): string => {
  const text = string(value, label);
  if (text.length > max) {
    throw new VendoError("validation", `${label} must be 1-${max} characters`);
  }
  return text;
};

/** ONE slot from the report body. Validated here — the one place a
    host-authored descriptor crosses into the runtime. */
const descriptor = (value: unknown): { id: string; label: string; description?: string } => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VendoError("validation", "each slot must be an object");
  }
  const entry = value as Record<string, unknown>;
  const description = entry["description"];
  return {
    id: bounded(entry["id"], "slot id", SLOT_ID_MAX_CHARS),
    label: bounded(entry["label"], "slot label", SLOT_LABEL_MAX_CHARS),
    // Optional, because it is: a slot with no description is still a real
    // destination, and only the model reads the sentence.
    ...(description === undefined
      ? {}
      : { description: bounded(description, "slot description", SLOT_DESCRIPTION_MAX_CHARS) }),
  };
};

export const slotRoutes: RouteEntry[] = [
  // Batched on purpose: a page mounts every one of its slots in the same
  // render, so the whole page reports in ONE request rather than one per slot.
  route("POST", "/slots", async ({ request, deps, context }) => {
    const body = await requestJson(request);
    const reported = body["slots"];
    if (!Array.isArray(reported) || reported.length > SLOTS_REPORT_MAX) {
      throw new VendoError("validation", `slots must be an array of at most ${SLOTS_REPORT_MAX} entries`);
    }
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
