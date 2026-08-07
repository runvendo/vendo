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
  | "forbidden";

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

/** Never throws, even for hostile errors with throwing message/toString getters. */
export function safeErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === "string") return error.message;
    return String(error);
  } catch {
    return "unknown validation failure";
  }
}
