/**
 * The scripted fixtures' contract with the runtime that opens them.
 *
 * "Spending This Month" and "Money HQ" are the only two apps this demo does not
 * generate, and nothing in the app reads them back — the SCREEN RUNTIME does,
 * on every `apps.open()`. That gap is how they died silently: 0.26 deleted the
 * island jail (#1303), the island documents they carried stopped rendering, and
 * both scripted beats served a reviewer notice where the view belongs while the
 * suite stayed green.
 *
 * So this pins what the opener actually reads — the artifact is a SCREEN
 * (`source["app.tsx"]` is the whole app, no `tree`, no `components`, and no
 * `id`, which the seeder mints per user), its stamped hash and bytes describe
 * its own text, and every name it binds to is one this deployment really has:
 * a read-graded tool out of `.vendo`, a Kit component, or a Maple registry
 * component.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { kitComponentNames } from "@vendoai/apps/contract";
import judgments from "../../.vendo/judgments.json";
import tools from "../../.vendo/tools.json";
import { mapleRegistry } from "@/vendo/registry";
import moneyHq from "../../src/demo-script/fixtures/money-hq.json";
import spending from "../../src/demo-script/fixtures/spending-breakdown.json";

interface ScreenFixture {
  format: string;
  name: string;
  ui?: string;
  source?: Record<string, { hash: string; bytes: number; text?: string }>;
}

const fixtures: Array<[string, ScreenFixture]> = [
  ["spending-breakdown.json", spending as ScreenFixture],
  ["money-hq.json", moneyHq as ScreenFixture],
];

/** What a screen may import from "@vendo/screen": the whole Kit plus this
 *  host's own catalog — `screenCatalog`, on Maple's registry. */
const importable = new Set([...kitComponentNames(), ...Object.keys(mapleRegistry), "useQuery", "tools"]);

/** The risk the deployment really applies: the extractor grades nothing, the
 *  committed judgment does (the same merge `vendo sync` writes). */
const risk = (tool: string): string | undefined =>
  (judgments.tools as Record<string, { fields?: { risk?: string } }>)[tool]?.fields?.risk;

const declared = new Set(tools.tools.map((tool) => tool.name));

const screenOf = (fixture: ScreenFixture): string => {
  const text = fixture.source?.["app.tsx"]?.text;
  if (text === undefined) throw new Error("fixture carries no app.tsx text");
  return text;
};

const namesIn = (pattern: RegExp, source: string): string[] =>
  [...source.matchAll(pattern)].map((match) => match[1]);

describe.each(fixtures)("%s is a screen document", (_file, fixture) => {
  it("carries its app.tsx and nothing the opener would read first", () => {
    expect(fixture.format).toBe("vendo/app@1");
    expect(fixture.name.length).toBeGreaterThan(0);
    expect(fixture.ui).toBe("tree");
    expect(screenOf(fixture).trim().length).toBeGreaterThan(0);
    // The island shape, gone: a `tree` would be an older picture of the app and
    // `components` are the jail's islands, which no longer run.
    expect(fixture).not.toHaveProperty("tree");
    expect(fixture).not.toHaveProperty("components");
    // The seeder mints a deterministic per-user id (`demoAppId`); a baked one
    // would give every Maple user the same app row.
    expect(fixture).not.toHaveProperty("id");
  });

  it("stamps the hash and byte count of its own text", () => {
    const file = fixture.source?.["app.tsx"];
    const text = screenOf(fixture);
    expect(file?.hash).toBe(`sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`);
    expect(file?.bytes).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("reads only tools this deployment declares and grades read", () => {
    const queried = namesIn(/useQuery\(\s*"([^"]+)"/gu, screenOf(fixture));
    expect(queried.length).toBeGreaterThan(0);
    for (const tool of queried) {
      expect(declared.has(tool), `${tool} is not in .vendo/tools.json`).toBe(true);
      // A screen may only `useQuery` a read: a read runs on every render.
      expect(risk(tool), `${tool} is graded ${risk(tool)}`).toBe("read");
    }
  });

  it("imports only names the screen surface declares", () => {
    const imported = namesIn(/import\s*\{([^}]+)\}\s*from\s*"@vendo\/screen"/gu, screenOf(fixture))
      .flatMap((clause) => clause.split(",").map((name) => name.trim()))
      .filter((name) => name.length > 0);
    expect(imported.length).toBeGreaterThan(0);
    for (const name of imported) {
      expect(importable.has(name), `${name} is neither a Kit nor a Maple component`).toBe(true);
    }
  });
});
