/**
 * What a zod schema IS, in ONE vocabulary across zod 3 and zod 4.
 *
 * Two walkers read the Kit's schemas — the checks floor's TypeScript printer
 * (`server/checking/screen-typings.ts`) and the catalog prompt's compact type
 * text (`kit/catalog-prompt.ts`) — and both used to switch on `_def.typeName`
 * against `z.ZodFirstPartyTypeKind`. zod 4 has neither: the def carries `type`
 * instead, and the enum is gone, so every `case` compared `undefined` against
 * `undefined` and the FIRST one matched. Live on 0.27.1, where the peer range
 * admits zod 4: every prop in the Kit typed as `string`, 37 "takes string"
 * refusals, every real screen rejected, nothing painted — and the `default:`
 * net that exists so imprecise typing never becomes a false positive could not
 * be reached to catch it.
 *
 * So the version knowledge lives here, once, and both walkers read the same
 * normalized answer. The two layouts are NOT merged field by field: zod 3 keeps
 * an array's element in `_def.type`, which is the very field zod 4 uses for the
 * tag, so the tag decides how the rest of the def is read. A def wearing
 * neither tag — a construct outside this vocabulary, a stub from a shim, or
 * nothing at all — is `"unsupported"`, which is the honest answer and the one
 * both walkers already degrade on.
 */
import type { ZodTypeAny } from "zod";

export type ZodKind =
  | "string" | "number" | "boolean" | "null"
  | "any" | "unknown"
  | "enum" | "literal" | "array" | "union" | "record" | "object"
  | "optional" | "nullable" | "effects"
  | "unsupported";

/** zod 3's `ZodFirstPartyTypeKind` members, spelled out rather than imported:
 *  the enum is the thing zod 4 does not ship, so reading it is what broke. */
const BY_TYPE_NAME: Readonly<Record<string, ZodKind>> = {
  ZodString: "string", ZodNumber: "number", ZodBoolean: "boolean", ZodNull: "null",
  ZodAny: "any", ZodUnknown: "unknown", ZodEnum: "enum", ZodLiteral: "literal",
  ZodArray: "array", ZodUnion: "union", ZodRecord: "record", ZodObject: "object",
  ZodOptional: "optional", ZodNullable: "nullable", ZodEffects: "effects",
};

/** zod 4's own tag — a plain lower-case string. `.transform()` became a
 *  two-ended `pipe`, whose `in` is the schema it started from. */
const BY_TYPE: Readonly<Record<string, ZodKind>> = {
  string: "string", number: "number", boolean: "boolean", null: "null",
  any: "any", unknown: "unknown", enum: "enum", literal: "literal",
  array: "array", union: "union", record: "record", object: "object",
  optional: "optional", nullable: "nullable", pipe: "effects",
};

export interface ZodShape {
  kind: ZodKind;
  /** The def's own tag, for the sentence a walker writes when it degrades. */
  tag?: string;
  /** An `enum`'s members, or a `literal`'s value — zod 4 literals hold a list. */
  values?: readonly unknown[];
  /** An `array`'s element, an `optional`/`nullable`'s inner schema, or the
   *  schema an `effects` started from. */
  inner?: ZodTypeAny;
  /** A `union`'s members. */
  options?: readonly ZodTypeAny[];
  /** A `record`'s value. */
  valueType?: ZodTypeAny;
  /** An `object`'s fields. */
  shape?: Readonly<Record<string, ZodTypeAny>>;
  /** An `object` that KEEPS what it does not declare. */
  passthrough?: boolean;
}

export function zodShape(schema: ZodTypeAny | undefined): ZodShape {
  const def = (schema as unknown as { _def?: Record<string, unknown> } | undefined)?._def ?? {};
  const typeName = typeof def["typeName"] === "string" ? def["typeName"] : undefined;
  const tag = typeName ?? (typeof def["type"] === "string" ? def["type"] : undefined);
  const kind = (typeName === undefined
    ? (tag === undefined ? undefined : BY_TYPE[tag])
    : BY_TYPE_NAME[typeName]) ?? "unsupported";
  const at = <T>(key: string): T | undefined => def[key] as T | undefined;
  const entries = at<Record<string, unknown>>("entries");
  const catchall = at<{ _def?: { type?: string } }>("catchall")?._def?.type;
  return {
    kind,
    tag,
    values: entries !== undefined ? Object.values(entries)
      : at<readonly unknown[]>("values") ?? ("value" in def ? [def["value"]] : undefined),
    // An array's element is the one field the two versions spell differently
    // ON THE SAME NAME, so it is read off the version that was detected.
    inner: (kind === "array" ? (typeName === undefined ? at<ZodTypeAny>("element") : at<ZodTypeAny>("type")) : undefined)
      ?? at<ZodTypeAny>("innerType")
      ?? (kind === "effects" ? at<ZodTypeAny>("schema") ?? at<ZodTypeAny>("in") : undefined),
    options: at<readonly ZodTypeAny[]>("options"),
    valueType: at<ZodTypeAny>("valueType"),
    shape: (schema as unknown as { shape?: Record<string, ZodTypeAny> } | undefined)?.shape,
    // zod 3 records the choice as a word and gives EVERY object a `catchall`
    // (`never` when it is closed); zod 4 drops the word and carries a catchall
    // only when the object really keeps something. So the tag decides here too
    // — reading both at once made every closed zod 3 object read as open.
    passthrough: typeName === undefined
      ? catchall !== undefined && catchall !== "never"
      : def["unknownKeys"] === "passthrough",
  };
}
