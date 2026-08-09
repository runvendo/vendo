/**
 * The floor's independence, as a guard rather than a promise.
 *
 * Blueprint §7.3 — the checking floor and the generation pipeline were mutually
 * entangled (`facts.ts` imported `GenerationDependencies` from
 * `generation/engine.js`, the reviewer imported the pipeline's prompt and its
 * strict-tool-call helper), so the conductor could not be quarantined without
 * taking the floor down with it. The floor now owns its own dependency type, and
 * this test is what keeps it that way: a floor that reaches back into the
 * pipeline is a floor that dies with the pipeline.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = join(dirname(fileURLToPath(import.meta.url)), "../../src/checking");

const sources = readdirSync(here).filter((name) => name.endsWith(".ts"));

describe("the checking floor owns its own dependencies (§7.3)", () => {
  it("has source files to check", () => {
    expect(sources.length).toBeGreaterThan(4);
  });

  it("imports nothing from the generation pipeline", () => {
    const offenders = sources.flatMap((name) => {
      const text = readFileSync(join(here, name), "utf8");
      return /from "\.\.\/generation\//.test(text) ? [name] : [];
    });
    expect(offenders).toEqual([]);
  });
});
