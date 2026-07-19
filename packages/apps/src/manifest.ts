import { VendoError } from "@vendoai/core";
import { z } from "zod";

/** execution-v2 spec ("The skin of the box") — `vendo.json`, the manifest an
 * app ships at its box root. v2 carries exactly two declarations and nothing
 * else (YAGNI): `schedules` ("at this cron, POST /fn/<name>"), read by the
 * scheduler broker (Wave 2 Lane D), and `egress`, the outbound-domain
 * allowlist the sandbox network layer enforces (Wave 2 Lane E). Declarative
 * only — no runtime library is required inside the box. */

/** The fn-name half of core's 01 §8 `fn:<name>` grammar, bounded like tool
 * route names — a schedule targets `POST /fn/<name>`, never a `fn:` ref. */
const FN_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/** Five whitespace-separated cron fields ("0 8 * * *"). Field syntax stays the
 * broker's concern; the manifest gate pins the shape so a typo\'d schedule
 * fails at parse time, not silently at fire time. */
const CRON_FIELD_PATTERN = /^[0-9A-Za-z*,/-]+$/;
const isCronExpression = (value: string): boolean => {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => CRON_FIELD_PATTERN.test(field));
};

export interface VendoManifestSchedule {
  cron: string;
  fn: string;
}

export interface VendoManifest {
  schedules?: VendoManifestSchedule[];
  egress?: string[];
}

/** Strict on every level: an unknown key is a loud validation error, so a
 * manifest written against a future contract fails at the seam that reads it
 * instead of being silently half-honored. */
export const vendoManifestSchema = z.object({
  schedules: z.array(
    z.object({
      cron: z.string().refine(isCronExpression, {
        message: "cron must be five whitespace-separated fields (e.g. \"0 8 * * *\")",
      }),
      fn: z.string().regex(FN_NAME_PATTERN, {
        message: "fn must be a bare fn name (POST /fn/<name> target), matching [A-Za-z_][A-Za-z0-9_-]{0,63}",
      }),
    }).strict(),
  ).optional(),
  egress: z.array(z.string().min(1)).optional(),
}).strict() satisfies z.ZodType<VendoManifest>;

/** Parse + validate a `vendo.json` source. Every seam that reads the manifest
 * calls this; an invalid manifest is a loud VendoError("validation"), never a
 * silently-dropped declaration. */
export function parseVendoManifest(source: string): VendoManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new VendoError("validation", "vendo.json is not valid JSON");
  }
  const parsed = vendoManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined || issue.path.length === 0 ? "manifest" : issue.path.join(".");
    throw new VendoError("validation", `invalid vendo.json: ${path}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}
