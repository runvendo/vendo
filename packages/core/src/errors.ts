import { z } from "zod";
import type { Json } from "./ids.js";

/** 01-core §15 */
export type VendoErrorCode =
  | "validation"
  | "blocked"
  | "not-implemented"
  | "sandbox-unavailable"
  | "cloud-required"
  | "not-found"
  | "conflict"
  /** Build contract §9.4 — the caller provably SEES the thing and is denied the
      action anyway (a viewer asked to edit). Thrown only to a proven viewer;
      anything they cannot see stays `not-found`. Wire-mapped to HTTP 403. */
  | "forbidden"
  /** A transient failure on the SERVER's own dependency (a dropped database
      connection, an upstream 5xx/429) — retry the same call verbatim rather
      than treating it as a business refusal. Wire-mapped to HTTP 503.
      Distinct from `sandbox-unavailable`, which names one specific capability
      rather than "something downstream broke". */
  | "unavailable"
  /** A typed store refused a write to a table it has not been told about and
      answered the DDL that would make the write legal — the proposal, carried
      here on `detail`. The store client confirms it and replays the write
      (hostedStore's `mutate`), so a caller only ever sees this code when that
      handshake was exhausted or the proposal named no app to confirm it
      against. Wire-mapped to HTTP 409. */
  | "schema-proposal";

/** 01-core §15 */
export const vendoErrorCodeSchema = z.enum([
  "validation",
  "blocked",
  "not-implemented",
  "sandbox-unavailable",
  "cloud-required",
  "not-found",
  "conflict",
  "forbidden",
  "unavailable",
  "schema-proposal",
]) satisfies z.ZodType<VendoErrorCode>;

/** 01-core §15 */
export class VendoError extends Error {
  /** 01-core §15 */
  code: VendoErrorCode;

  /** 01-core §15 */
  detail?: Json;

  /** 01-core §15 */
  constructor(code: VendoErrorCode, message: string, detail?: Json) {
    super(message);
    this.name = "VendoError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * `instanceof VendoError`, ACROSS REALMS — which is what every caller meant.
 *
 * A host bundle can carry two copies of this package (the ESM `dist/` beside the
 * CJS `dist/cjs/`, the dual-package hazard), and the second copy's VendoErrors
 * are a different class: same crafted message, same code enum, `instanceof` says
 * no. 0.27.0 shipped on that: a hosted-store refusal minted in the other realm
 * missed the wire's `instanceof` gate, reached the catch-all as an unknown fault,
 * and answered 501 for the life of the process.
 *
 * The duck check is as safe as the class check, because the class adds nothing a
 * caller reads — `name` is set in the constructor and `code` is the enum.
 */
export const isVendoError = (error: unknown): error is VendoError =>
  error instanceof VendoError
  || (error instanceof Error && error.name === "VendoError" && typeof (error as { code?: unknown }).code === "string");

/** Never throws, even for hostile errors with throwing message/toString getters. */
export function safeErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === "string") return error.message;
    return String(error);
  } catch {
    return "unknown validation failure";
  }
}
