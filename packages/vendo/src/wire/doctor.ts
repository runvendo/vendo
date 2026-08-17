import type { ExtractedTool } from "@vendoai/actions";
import { principalSchema, type Principal, type ToolOutcome } from "@vendoai/core";
import { tickSecret } from "../tick-enrolment.js";
import { BASE_PATH, environment, json, route, type RouteEntry } from "./shared.js";

/** The composition probe surface, for anything that wants to check a running
    deployment over HTTP: the synthetic credential/actAs round-trip constants
    and tool descriptors, and the /doctor wire routes. server.ts keeps only the
    deps.doctor probe-executor wiring (the probes run through a real
    createActions). `vendo doctor` reads files and does not call these. */

const DOCTOR_PRESENT_AUTHORIZATION = "Bearer vendo-doctor-present";
const DOCTOR_PRESENT_COOKIE = "vendo_doctor_present=1";
export const DOCTOR_ACT_AS_PRINCIPAL: Principal = { kind: "user", subject: "vendo_doctor_act_as" };
export const DOCTOR_ACT_AS_APP_ID = "app_vendo_doctor" as const;

export const doctorPresentTool: ExtractedTool = {
  name: "vendo_doctor_present",
  description: "Vendo doctor present credential round-trip",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
  binding: { kind: "route", method: "GET", path: `${BASE_PATH}/doctor/present/echo`, argsIn: "query" },
};

export const doctorActAsTool: ExtractedTool = {
  name: "vendo_doctor_act_as",
  description: "Vendo doctor actAs mint and verification round-trip",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
  binding: { kind: "route", method: "GET", path: `${BASE_PATH}/doctor/act-as/echo`, argsIn: "query" },
};

function doctorProbeOk(outcome: ToolOutcome): boolean {
  if (outcome.status !== "ok" || typeof outcome.output !== "object" || outcome.output === null) return false;
  return "ok" in outcome.output && outcome.output.ok === true;
}

/** The one doctor route mounted in EVERY environment (09-vendo §2 install-dx
    wave 1.1): unlike the probes below it reports a static composition fact (is
    VENDO_BASE_URL set?) revealing no secret material, and the environment it
    exists to warn about is production — the very one the probe surface is
    closed in. Kept as its own group so the mounting rule is visible at the
    route table rather than buried in a gate's ordering. */
export const doctorBaseUrlRoutes: RouteEntry[] = [
  route("GET", "/doctor/base-url", async () => {
    const missingInProduction = environment("NODE_ENV") === "production" && environment("VENDO_BASE_URL") === undefined;
    if (missingInProduction) {
      return json({
        ok: false,
        error: {
          code: "base-url-not-set-in-production",
          message: "VENDO_BASE_URL is not set in production. Present-mode host tool calls that need to forward the caller's credentials fail closed instead of running unauthenticated. Set VENDO_BASE_URL to this deployment's public origin and restart the server.",
        },
      }, 409);
    }
    return json({ ok: true });
  }),
];

/** The PROBE surface — a composition that did not say it is development never
    gets these routes at all (server.ts mounts the group behind
    `deps.development`). Mounting is the
    only thing standing between them and an unauthenticated caller: none takes a
    principal, `/doctor/machines` reports every machine-bearing app in the
    deployment across every subject, and POST `/doctor/act-as` makes the
    composition mint host actAs material on demand. The gate this replaced was a
    per-request `NODE_ENV === "production"` refusal, which answers "not
    production" for an unset NODE_ENV and on every runtime with no `process`
    global. */
export const doctorRoutes: RouteEntry[] = [
  // Machine/schedule reporting. Reporting only: which apps carry a machine, what
  // their manifests declare, and whether ANY waker can reach the /tick surface —
  // the same ladder the door itself verifies against (tick-enrolment.ts), so a
  // Cloud deployment that configured nothing still reads as configured, because
  // its heartbeat knocks. WHEN a schedule last fired is not here:
  // a vendo.json schedule is a doc trigger, so its history is the automation's
  // run records.
  route("GET", "/doctor/machines", async ({ deps }) => {
    return json({
      scheduleCallerConfigured: (await tickSecret()) !== undefined,
      machines: await deps.apps.machine.report(),
    });
  }),
  route("GET", "/doctor/present/echo", async ({ request }) => {
    return json({
      ok: request.headers.get("authorization") === DOCTOR_PRESENT_AUTHORIZATION
        && request.headers.get("cookie") === DOCTOR_PRESENT_COOKIE,
    });
  }),
  route("GET", "/doctor/act-as/echo", async ({ request, deps }) => {
    const resolved = await deps.principal(request);
    const parsed = principalSchema.safeParse(resolved);
    const accepted = parsed.success && parsed.data.subject === DOCTOR_ACT_AS_PRINCIPAL.subject;
    return json({ ok: accepted }, accepted ? 200 : 401);
  }),
  route("POST", "/doctor/present", async ({ deps, context }) => {
    const outcome = await deps.doctor.present(await context("chat"));
    if (doctorProbeOk(outcome)) return json({ ok: true });
    return json({
      ok: false,
      error: {
        code: "present-credentials-not-forwarded",
        message: "Present credentials did not reach the host API. Set VENDO_BASE_URL to the running host origin and restart the dev server.",
      },
    }, 409);
  }),
  route("POST", "/doctor/act-as", async ({ deps }) => {
    const outcome = await deps.doctor.actAs();
    if (doctorProbeOk(outcome)) return json({ ok: true });
    // The probe executor calls the actions registry directly (no guard
    // binding), so the actAs disposition passthrough survives on the outcome —
    // the one discriminator between "no seam" and "a seam that said no": a
    // configured host whose subject→user resolver declines the synthetic
    // doctor principal must not be told actAs is unconfigured (#873).
    const disposition = (outcome as { actAs?: string }).actAs;
    if (outcome.status === "error" && outcome.error.code === "not-implemented") {
      if (disposition === "declined") {
        return json({
          ok: false,
          error: { code: "act-as-declined", message: outcome.error.message },
        }, 409);
      }
      return json({
        ok: false,
        error: {
          code: "act-as-not-configured",
          message: "actAs is not configured; pass createVendo({ actAs }) before enabling away host actions.",
        },
      }, 501);
    }
    return json({
      ok: false,
      error: {
        code: "act-as-verification-failed",
        // The registry's own error text is the actionable half (it can name a
        // missing module or the mint failure); never replace it with a
        // generic line (#873).
        message: outcome.status === "error"
          ? `actAs round-trip failed: ${outcome.error.message}`
          : "actAs returned no usable AuthMaterial, or the composition's principal resolver did not accept it. Check the actAs seam and principal resolver.",
      },
    }, 409);
  }),
];
