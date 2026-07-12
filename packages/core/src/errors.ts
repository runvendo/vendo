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
  | "conflict";

/** 01-core §15 */
export const vendoErrorCodeSchema = z.enum([
  "validation",
  "blocked",
  "not-implemented",
  "sandbox-unavailable",
  "cloud-required",
  "not-found",
  "conflict",
]) satisfies z.ZodType<VendoErrorCode>;

/** 01-core §15 */
export class VendoError extends Error {
  /** 01-core §15 */
  readonly code: VendoErrorCode;

  /** 01-core §15 */
  readonly detail?: Json;

  /** 01-core §15 */
  constructor(code: VendoErrorCode, message: string, detail?: Json) {
    super(message);
    this.name = "VendoError";
    this.code = code;
    this.detail = detail;
  }
}
