import { VendoError, isoDateTimeSchema, type IsoDateTime, type Json } from "@vendoai/core";

export function iso(value: unknown): IsoDateTime {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new Error("Expected database timestamp");
  }
  return new Date(value).toISOString();
}

export function optionalIso(value: unknown): IsoDateTime | undefined {
  return value == null ? undefined : iso(value);
}

export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected database text");
  return value;
}

export function json(value: unknown): Json {
  return value;
}

export function encodeCursor(date: IsoDateTime, id: string): string {
  return Buffer.from(JSON.stringify({ c: date, i: id }), "utf8").toString("base64url");
}

export function decodeCursor(value: string): { c: IsoDateTime; i: string } {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("non-canonical cursor");
    const parsed = JSON.parse(decoded.toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" || parsed === null
      || Array.isArray(parsed)
      || Object.keys(parsed).length !== 2
      || !Object.prototype.hasOwnProperty.call(parsed, "c")
      || !Object.prototype.hasOwnProperty.call(parsed, "i")
      || typeof (parsed as { c?: unknown }).c !== "string"
      || typeof (parsed as { i?: unknown }).i !== "string"
    ) throw new Error("invalid cursor");
    const timestamp = isoDateTimeSchema.safeParse((parsed as { c: string }).c);
    if (!timestamp.success) throw new Error("invalid cursor timestamp");
    return { c: timestamp.data, i: (parsed as { i: string }).i };
  } catch {
    throw new VendoError("validation", "malformed cursor");
  }
}

export function pageLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value < 1) {
    throw new VendoError("validation", "limit must be a positive integer");
  }
  return Math.min(value, 1000);
}

export function jsonParam(value: unknown): string {
  return JSON.stringify(value);
}
