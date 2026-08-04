/**
 * Executable host fixtures (Task 3): every cataloged tool has a deterministic
 * seed-data executor whose output conforms to the fixture's own shape card;
 * unknown tools throw VendoError. Zero model calls, zero live servers.
 */
import { describe, expect, it } from "vitest";
import { isPlainObject, VendoError, type Json, type ShapeType } from "@vendoai/core";
import type { HostToolInfo } from "@vendoai/apps";
import { fixtures } from "./index";
import type { HostFixture, HostName } from "../runner/types";

/** Value-level conformance walk over core's ShapeType (core ships derivation
 *  and binding checks, not a value checker — this is the test's own gate). */
const conforms = (value: Json | undefined, shape: ShapeType): boolean => {
  switch (shape.kind) {
    case "json":
      return value !== undefined;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value) && value.every((item) => conforms(item, shape.items));
    case "object": {
      if (!isPlainObject(value)) return false;
      const optional = new Set(shape.optional ?? []);
      return Object.entries(shape.fields).every(([key, field]) =>
        value[key] === undefined ? optional.has(key) : conforms(value[key] as Json, field));
    }
  }
};

/** Sample inputs for tools whose input schema has required members; every
 *  read tool must tolerate `{}` (canned data: an unknown id falls back to the
 *  first seed entity so a generated app can never dead-end a render). */
const SAMPLE_INPUTS: Record<string, Record<string, unknown>> = {
  host_transferMoney: { amount: 50_000, recipient_name: "Alex Rivera", memo: "June rent" },
  host_createOrder: { body: { merchant: "DoorDash", amountCents: 3_184, descriptor: "DOORDASH*THAI", items: "Pad see ew" } },
  host_sendClientMessage: { id: "cl_rivera", body: { body: "Reminder: your W-2 is still outstanding." } },
  host_setDocumentStatus: { id: "cl_rivera", docId: "doc_rivera_w2", body: { action: "receive", fileName: "w2-2025.pdf" } },
};

const hostNames = Object.keys(fixtures) as HostName[];

describe("host fixtures", () => {
  it("exports both hosts", () => {
    expect(hostNames.sort()).toEqual(["cadence", "maple"]);
  });

  for (const hostName of hostNames) {
    const fixture = fixtures[hostName] as HostFixture;
    const tools = fixture.tools as HostToolInfo[];
    const shapes = fixture.shapes as Record<string, ShapeType>;

    describe(hostName, () => {
      it("has a non-empty catalog, tool list, shape cards, and theme", () => {
        expect((fixture.catalog as unknown[]).length).toBeGreaterThan(0);
        expect(tools.length).toBeGreaterThan(0);
        expect(Object.keys(shapes).length).toBeGreaterThan(0);
        expect(isPlainObject(fixture.theme)).toBe(true);
        expect((fixture.theme as { colors?: unknown }).colors).toBeDefined();
      });

      it("keeps auth/demo/voice plumbing out of the generation surface", () => {
        for (const tool of tools) {
          expect(tool.name).not.toMatch(/^host_(auth|demo|voice)/);
          expect(tool.name).not.toMatch(/Demo|VoiceSession/);
        }
      });

      for (const tool of tools) {
        it(`executes ${tool.name} with shape-conformant output`, async () => {
          const output = (await fixture.execute(tool.name, SAMPLE_INPUTS[tool.name] ?? {})) as Json;
          expect(output).not.toBeUndefined();
          const shape = shapes[tool.name];
          if (shape !== undefined) {
            expect(conforms(output, shape), `${tool.name} output does not conform to its shape card`).toBe(true);
          }
        });
      }

      it("is deterministic: same call, same data", async () => {
        // Keyed by name, not by risk: these catalogs are extracted, and
        // extraction grades from protocol facts only — a plain GET list
        // endpoint is `ungraded` until something authorized grades it.
        const listTool = tools.find((tool) => tool.name.startsWith("host_list")) as HostToolInfo;
        expect(listTool).toBeDefined();
        const first = await fixture.execute(listTool.name, {});
        const second = await fixture.execute(listTool.name, {});
        expect(second).toEqual(first);
      });

      it("throws VendoError for an unknown tool", async () => {
        await expect(fixture.execute("host_doesNotExist", {})).rejects.toSatisfy(
          (error) => error instanceof VendoError && error.code === "not-found",
        );
      });
    });
  }
});
