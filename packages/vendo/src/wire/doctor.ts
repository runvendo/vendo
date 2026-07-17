import type { ExtractedTool } from "@vendoai/actions";
import { VendoError, principalSchema, type Principal, type ToolOutcome } from "@vendoai/core";
import { BASE_PATH, environment, json, prefixRoute, route, type RouteEntry } from "./shared.js";

/** The doctor probe surface (CLI `vendo doctor` targets a running dev server):
    the synthetic credential/actAs round-trip constants and tool descriptors,
    and the /doctor wire routes. server.ts keeps only the deps.doctor
    probe-executor wiring (the probes run through a real createActions). */

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

/** Doctor targets a running dev server. The prefix gate keeps its synthetic
    mint/echo routes out of production entirely (and falls through in
    development); the echo halves expose no credential material — booleans
    only. */
export const doctorRoutes: RouteEntry[] = [
  prefixRoute("*", "/doctor/", async () => {
    if (environment("NODE_ENV") === "production") {
      throw new VendoError("not-found", "unknown Vendo route");
    }
    return undefined;
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
    if (outcome.status === "error" && outcome.error.code === "not-implemented") {
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
        message: "actAs returned no usable AuthMaterial, or the host API did not accept it. Check the matching verifier middleware and principal resolver.",
      },
    }, 409);
  }),
];
