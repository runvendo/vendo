/**
 * Every world folder, linted through the same two loaders a run uses.
 *
 * `loadWorld`/`loadCases` cast authored JSON rather than validate it, so a world
 * authored in dollars, a read that returns no rows, or a case whose data override
 * names a tool the world does not have first surfaces hours later on a
 * contender's page, priced in model tokens — and reads as a model failure.
 *
 * The folder list is read at collection time, so a world added tomorrow is linted
 * the day it lands without a name being added to this file.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vendoThemeSchema } from "@vendoai/apps/contract";
import { TOOL_NAME_PATTERN } from "@vendoai/core";
import { beforeAll, describe, expect, it } from "vitest";
import { CASE_SHAPES, loadCases, loadWorld, type Case, type CaseTag, type World } from "../src/world.js";

const worldsDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "worlds");

const folders = readdirSync(worldsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every field in a blob of authored data, keyed and pathed, however deep. One
 *  walk feeds both the money rule and the id-reference rule. */
function* fields(value: unknown, path: string): Generator<{ path: string; key: string; value: unknown }> {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* fields(item, `${path}[${index}]`);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      yield { path: `${path}.${key}`, key, value: item };
      yield* fields(item, `${path}.${key}`);
    }
  }
}

/** The rows a read answers with: the `data` array a world tool wraps them in, or
 *  the array itself when one is authored bare. */
function rowsOf(data: unknown): readonly unknown[] | undefined {
  if (Array.isArray(data)) return data;
  if (isRecord(data) && Array.isArray(data["data"])) return data["data"];
  return undefined;
}

/** An authored list of prose with something on every line — what the world's
 *  style rubric and a case's pass lines both have to be. */
const hasLines = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0 && value.every((line) => typeof line === "string" && line.trim() !== "");

/** A key's words, snake or camel: `amountCents` and `amount_cents` both read as
 *  ["amount", "cents"]. */
const wordsOf = (key: string): readonly string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const MONEY_WORDS = new Set(["cents", "amount", "price", "total", "balance", "subtotal", "fee", "rent", "cost"]);

/** The LAST word decides, so `balance`, `late_fee`, `amount_cents` and
 *  `amountCents` are money and `total_count` is not. */
const isMoneyKey = (key: string): boolean => {
  const last = wordsOf(key).at(-1);
  return last !== undefined && MONEY_WORDS.has(last);
};

/** The entity a foreign-id field names, as its last word: `account_id`,
 *  `accountId` and `source_account_id` all point at accounts. A bare `id` is the
 *  row's own, and `valid` is not a reference — the suffix needs a boundary. */
const referenceEntity = (key: string): string | undefined => {
  const match = /^(.+?)(?:_ids?|Ids?)$/.exec(key);
  return match === null ? undefined : wordsOf(match[1]!).at(-1);
};

/** Does a tool's name own this entity? `list_accounts` owns `account`. */
const namesEntity = (toolName: string, entity: string): boolean =>
  wordsOf(toolName).some((word) => word === entity || word === `${entity}s`);

/** Families that name no face to ship — a theme asking for the system stack is
 *  complete without a `font.woff2` beside it. */
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "cursive",
  "fantasy",
  "math",
  "inherit",
]);

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CASE_TAGS: readonly CaseTag[] = ["display", "action"];

it("has a world to lint", () => {
  // An empty worlds/ would make every rule below pass by having nothing to say.
  expect(folders).not.toEqual([]);
});

for (const name of folders) {
  describe(`worlds/${name}`, () => {
    const dir = join(worldsDir, name);
    let world: World;
    let cases: readonly Case[];

    // The real read path, and the parse rules themselves: a folder the run cannot
    // load — bad JSON, a duplicate case id — fails every rule below with the
    // loader's own message.
    beforeAll(async () => {
      world = await loadWorld(dir);
      cases = await loadCases(join(dir, "cases.json"));
    });

    it("parses into every field the harness reads", () => {
      vendoThemeSchema.parse(world.theme);
      expect(typeof world.app === "string" && world.app.trim() !== "", "app").toBe(true);
      expect(hasLines(world.style), "style rubric").toBe(true);
      expect(world.tools.length).toBeGreaterThan(0);
    });

    it("ships the face its theme names", () => {
      const first = world.theme.typography.fontFamily.split(",")[0]!.trim().replace(/^['"]|['"]$/g, "");
      if (GENERIC_FAMILIES.has(first.toLowerCase())) return;
      expect(world.font, `the theme names ${first} but the folder ships no font.woff2`).toBeDefined();
    });

    it("names every tool the way the contract allows", () => {
      expect(world.tools.map((tool) => tool.name).filter((toolName) => !TOOL_NAME_PATTERN.test(toolName))).toEqual([]);
    });

    it("gives every read rows and every write arguments", () => {
      // A read with no rows grades nothing, and a write with no arguments cannot
      // be aimed at the row it acts on.
      const emptyReads = world.tools
        .filter((tool) => tool.descriptor.risk === "read" && (rowsOf(tool.data)?.length ?? 0) === 0)
        .map((tool) => tool.name);
      expect(emptyReads, "a read must return at least one row").toEqual([]);

      const bareWrites = world.tools
        .filter((tool) => tool.descriptor.risk === "write"
          && ((tool.descriptor.inputSchema["required"] as readonly string[] | undefined) ?? []).length === 0)
        .map((tool) => tool.name);
      expect(bareWrites, "a write must declare takes").toEqual([]);
    });

    it("keeps every money field in integer cents", () => {
      // Integer cents on purpose: a world authored in dollars lets a 100x scale
      // error past the fabrication check (tests/floor.test.ts).
      const authored = [
        ...world.tools.map((tool) => ({ label: tool.name, data: tool.data })),
        ...cases.flatMap((entry) =>
          Object.entries(entry.data ?? {}).map(([toolName, data]) => ({ label: `${entry.id}:${toolName}`, data })),
        ),
      ];

      const offenders = authored.flatMap(({ label, data }) =>
        [...fields(data, label)]
          .filter((field) => typeof field.value === "number" && isMoneyKey(field.key) && !Number.isInteger(field.value))
          .map((field) => `${field.path} = ${String(field.value)}`),
      );
      expect(offenders, "money is authored in integer cents").toEqual([]);
    });

    it("resolves every id a row points at", () => {
      const idsByTool = world.tools.map(
        (tool) =>
          [
            tool.name,
            new Set((rowsOf(tool.data) ?? []).flatMap((row) => (isRecord(row) && typeof row["id"] === "string" ? [row["id"]] : []))),
          ] as const,
      );
      const everyId = new Set(idsByTool.flatMap(([, ids]) => [...ids]));

      const dangling = world.tools.flatMap((tool) =>
        [...fields(tool.data, tool.name)].flatMap((field) => {
          const entity = referenceEntity(field.key);
          if (entity === undefined) return [];
          const referenced = (Array.isArray(field.value) ? field.value : [field.value]).filter(
            (value): value is string => typeof value === "string",
          );
          // The tool the NAME points at when there is one, so an error names the
          // set the id was checked against; otherwise every id the world returns.
          const owned = idsByTool.filter(([toolName]) => namesEntity(toolName, entity)).flatMap(([, ids]) => [...ids]);
          const allowed = new Set(owned.length > 0 ? owned : everyId);
          // A world where nothing is keyed by id has no set to resolve against.
          if (allowed.size === 0) return [];
          return referenced.filter((id) => !allowed.has(id)).map((id) => `${field.path} = ${id}`);
        }),
      );
      expect(dangling, "a row points at an id no tool returns").toEqual([]);
    });

    it("gives every case a kebab-case id", () => {
      // Uniqueness is `loadCases`' own rule, enforced above by loading them.
      expect(cases.map((entry) => entry.id).filter((id) => !KEBAB.test(id))).toEqual([]);
    });

    it("gives every case pass lines to be graded on", () => {
      const offenders = cases.filter((entry) => !hasLines(entry.pass)).map((entry) => entry.id);
      expect(offenders, "a case with no pass lines is graded on nothing").toEqual([]);
    });

    it("tags every case display or action, at least two of them actions", () => {
      const mistagged = cases
        .filter((entry) => (entry.tags ?? []).filter((tag) => CASE_TAGS.includes(tag)).length !== 1)
        .map((entry) => entry.id);
      expect(mistagged, "each case carries exactly one of display | action").toEqual([]);

      // Two, not three: `action` is what makes the floor demand an OBSERVED tool
      // call, and the probe only reaches a control that fires from the default
      // state in one click, optionally through one confirmation dialog. A wizard
      // whose write sits on step three is graded on its shape, so it is tagged
      // `display` however much it is "about" a write — which leaves a world with
      // a single write tool (fieldops, `dispatch_job`) two honest action cases,
      // and a third could only be invented.
      const actions = cases.filter((entry) => (entry.tags ?? []).includes("action"));
      expect(actions.length, "a world whose cases never act grades no write tool").toBeGreaterThanOrEqual(2);
    });

    it("gives every case one shape, and any source it names a real one", () => {
      const shapeless = cases.filter((entry) => !CASE_SHAPES.includes(entry.shape)).map((entry) => entry.id);
      expect(shapeless, `each case carries one shape of ${CASE_SHAPES.join(" | ")}`).toEqual([]);

      // `source` stays optional — a case authored before the sweep names no screen.
      const blank = cases
        .filter((entry) => entry.source !== undefined && (typeof entry.source !== "string" || entry.source.trim() === ""))
        .map((entry) => entry.id);
      expect(blank, "a case that declares a source names one").toEqual([]);
    });

    it("carries at least ten cases", () => {
      expect(cases.length).toBeGreaterThanOrEqual(10);
    });

    it("overrides only tools and fields the world has", () => {
      const dataByTool = new Map(world.tools.map((tool) => [tool.name, tool.data] as const));
      const offenders: string[] = [];
      for (const entry of cases) {
        for (const [toolName, override] of Object.entries(entry.data ?? {})) {
          if (!dataByTool.has(toolName)) {
            offenders.push(`${entry.id}: no tool named ${toolName}`);
            continue;
          }
          const authored = dataByTool.get(toolName);
          // The wrapper the tool answers with, then the row fields it authors.
          // An override of a tool with no authored rows has nothing to check.
          if (isRecord(authored) && isRecord(override)) {
            for (const key of Object.keys(override)) {
              if (!Object.hasOwn(authored, key)) offenders.push(`${entry.id}: ${toolName} answers with no "${key}"`);
            }
          }
          const authoredFields = new Set((rowsOf(authored) ?? []).flatMap((row) => (isRecord(row) ? Object.keys(row) : [])));
          if (authoredFields.size === 0) continue;
          for (const row of rowsOf(override) ?? []) {
            if (!isRecord(row)) continue;
            for (const key of Object.keys(row)) {
              if (!authoredFields.has(key)) offenders.push(`${entry.id}: ${toolName} rows have no "${key}"`);
            }
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });
}
