/**
 * THE SAME TYPES, OFF A ZOD 4 KIT.
 *
 * `@vendoai/apps` takes zod as a PEER (`>=3.25.0 <5`), so the Kit's specs are
 * built by whatever zod the HOST installed — and under zod 4 both walkers went
 * blind. They switched on `_def.typeName` against `z.ZodFirstPartyTypeKind`;
 * zod 4 carries `_def.type` instead and ships no enum, so every `case` compared
 * `undefined` to `undefined`, the first one matched, and every prop in the Kit
 * typed as `string`. Live on 0.27.1: 37 "takes string" refusals, every real
 * screen rejected, nothing painted while the agent reported success.
 *
 * The whole module graph is swapped here, because that is the only faithful
 * shape of the failure: the specs, the walkers and the printer all have to see
 * one zod. `zod/v4` IS zod 4 — the same implementation the standalone package
 * ships, re-exported by the zod 3.25 line this repo resolves — so nothing about
 * these schemas is a fixture.
 *
 * `ZodFirstPartyTypeKind: {}` reproduces the one detail that made the failure
 * SILENT rather than loud: a zod 4 that answers the old lookup with an object
 * whose members are all undefined, instead of throwing on a missing enum. The
 * fix must not care either way — it never reads the enum again.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("zod", async () => {
  const v4 = await import("zod/v4");
  return { ...v4, z: { ...v4, ZodFirstPartyTypeKind: {} }, default: v4 };
});

const typings = async (): Promise<string> => {
  const { screenTypings } = await import("../../src/server/checking/screen-typings.js");
  return screenTypings({ catalog: [], queries: [] });
};

const lineFor = (text: string, name: string): string =>
  text.split("\n").find((line) => line.includes(`declare const ${name}:`)) ?? "";

describe("the Kit's own types survive the zod the host installed", () => {
  it("prints a number as number, an enum as its members, and a record as a record", async () => {
    const stack = lineFor(await typings(), "Stack");

    // Every one of these came out `string` under zod 4 — the live tree, verbatim:
    // `gap?: string | VendoBinding; style?: string | VendoBinding; …`.
    expect(stack).toContain("gap?: number | VendoBinding");
    expect(stack).toContain("style?: Record<string, string | number> | VendoBinding");
    expect(stack).toContain(`density?: "comfortable" | "compact" | VendoBinding`);
  });

  it("prints a boolean as boolean and an array of objects as one", async () => {
    const table = lineFor(await typings(), "DataTable");

    expect(table).toContain("searchable?: boolean | VendoBinding");
    expect(table).toContain("rows: Array<Record<string, any>> | VendoBinding");
    expect(table).toContain("limit?: number | VendoBinding");
    // A slot is the one prop whose faithful `any` would admit a closure the
    // renderer cannot call, and it is found by DESCRIPTION — which zod 4 keeps.
    expect(table).toContain("empty?: VendoSlot | VendoBinding");
  });

  it("keeps an object that KEEPS what it does not declare, and closes the ones that do not", async () => {
    const table = lineFor(await typings(), "DataTable");

    // zod 3 says `unknownKeys: "passthrough"`; zod 4 says it with a catchall, and
    // gives a CLOSED object none — reading both at once made every closed object
    // in the Kit sprout an index signature.
    expect(table).toContain("cell?: VendoSlot }>");
    expect(lineFor(await typings(), "DonutChart")).toContain("; [prop: string]: any }");
  });

  it("says the same thing to the MODEL — the catalog prompt walks the same schemas", async () => {
    const { catalogPrompt } = await import("../../src/contract/kit/catalog-prompt.js");

    const stat = catalogPrompt({ only: ["Stat"], omitPreamble: true });

    expect(stat).toContain("value!: number|string");
    expect(stat).toContain("unit: string");
  });
});
