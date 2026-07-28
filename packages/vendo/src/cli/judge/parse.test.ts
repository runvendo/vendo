import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJudgeArtifact, repairJson } from "./parse.js";

/** The judge envelope's shape, minus the parts these tests do not exercise. */
const envelope = z.object({
  tools: z.array(z.unknown()),
  missedSurfaces: z.unknown().optional(),
  narrative: z.unknown().optional(),
});

const fenced = (body: string): string =>
  `Here is my judgment.\n\n\`\`\`json\n${body}\n\`\`\`\n`;

const grade = (index: number): string =>
  `    { "name": "host_tool_${index}", "risk": "read", "evidence": "return await db.select().from(t${index})" }`;

/**
 * rallly batch 5, as preserved: 20 complete tool grades, the tools array
 * properly closed, and a TRAILING COMMA after the narrative — two characters
 * from the end of otherwise-perfect output. Cost: 20 tools unjudged, 5
 * legitimate downgrades lost.
 */
const RALLLY_TRAILING_COMMA = fenced(
  `{\n  "tools": [\n${Array.from({ length: 20 }, (_, i) => grade(i)).join(",\n")}\n  ],\n`
  + `  "narrative": "Reviewed 20 handlers; five are plain authenticated reads mislabeled write.",\n}`,
);

/**
 * teable batch 1, as preserved: both tool grades complete and correct, killed
 * by a MISSING `]` — the missedSurfaces array is opened, its string is closed,
 * and then the object closes. Cost: the repo's entire score (0.000).
 */
const TEABLE_MISSING_BRACKET = fenced(
  `{\n  "tools": [\n${grade(0)},\n${grade(1)}\n  ],\n`
  + `  "narrative": "Two handlers reviewed.",\n`
  + `  "missedSurfaces": ["The GraphQL surface under packages/core produced zero tools."\n}`,
);

describe("repairJson — the two malformations real judge batches produce", () => {
  it("strips a trailing comma before a closing brace", () => {
    expect(JSON.parse(repairJson(`{"a": 1,}`)!)).toEqual({ a: 1 });
  });

  it("strips a trailing comma before a closing bracket", () => {
    expect(JSON.parse(repairJson(`{"a": [1, 2,]}`)!)).toEqual({ a: [1, 2] });
  });

  it("auto-closes an array left open when the object closes", () => {
    expect(JSON.parse(repairJson(`{"a": ["x"}`)!)).toEqual({ a: ["x"] });
  });

  it("auto-closes brackets left open at EOF, outermost last", () => {
    expect(JSON.parse(repairJson(`{"a": [{"b": 1`)!)).toEqual({ a: [{ b: 1 }] });
  });

  it("NEVER touches commas or braces inside a string literal", () => {
    const raw = `{"evidence": "const x = {a: 1,}; // trailing , here ]"}`;
    expect(JSON.parse(repairJson(raw)!)).toEqual({
      evidence: "const x = {a: 1,}; // trailing , here ]",
    });
  });

  it("closes an unterminated string before closing its brackets", () => {
    expect(JSON.parse(repairJson(`{"a": "unfinished`)!)).toEqual({ a: "unfinished" });
  });

  it("leaves already-valid JSON byte-identical", () => {
    const raw = `{"a":[1,2],"b":"x"}`;
    expect(repairJson(raw)).toBe(raw);
  });

  it("escaped quotes inside a string do not end it", () => {
    const raw = `{"a": "he said \\"hi\\" ,}"}`;
    expect(JSON.parse(repairJson(raw)!)).toEqual({ a: `he said "hi" ,}` });
  });
});

describe("parseJudgeArtifact — real preserved payloads", () => {
  it("recovers all 20 rallly grades from the trailing-comma payload", () => {
    const parsed = parseJudgeArtifact(RALLLY_TRAILING_COMMA, envelope);
    expect(parsed.repaired).toBe(true);
    expect(parsed.artifact.tools).toHaveLength(20);
    expect(parsed.artifact.narrative).toContain("Reviewed 20 handlers");
  });

  it("recovers both teable grades from the missing-bracket payload", () => {
    const parsed = parseJudgeArtifact(TEABLE_MISSING_BRACKET, envelope);
    expect(parsed.repaired).toBe(true);
    expect(parsed.artifact.tools).toHaveLength(2);
    expect(parsed.artifact.missedSurfaces).toEqual([
      "The GraphQL surface under packages/core produced zero tools.",
    ]);
  });

  it("well-formed output parses with no repair claimed", () => {
    const parsed = parseJudgeArtifact(fenced(`{"tools": [], "narrative": "nothing"}`), envelope);
    expect(parsed.repaired).toBe(false);
    expect(parsed.artifact.tools).toEqual([]);
  });
});

describe("parseJudgeArtifact — a failure stays LOUD, never a silent empty success", () => {
  it("throws on prose with no JSON at all", () => {
    expect(() => parseJudgeArtifact("I could not read the repo, sorry.", envelope)).toThrow();
  });

  it("throws on a fenced block that is not recoverable JSON", () => {
    expect(() => parseJudgeArtifact(fenced(`{"tools": [ %%% not json at all `), envelope)).toThrow();
  });

  it("NEVER accepts an inner tool object as a zero-tools success", () => {
    // The trap the diagnosis warned about: a bare tool object satisfies an
    // envelope whose `tools` DEFAULTS to [], so a span-scanning fallback would
    // return a cheerful "0 tools judged" instead of failing. `tools` is required
    // precisely so that cannot happen.
    const innerObjectOnly = `{ "name": "host_x", "risk": "read", "evidence": "db.select()" }`;
    expect(() => parseJudgeArtifact(innerObjectOnly, envelope)).toThrow();
    expect(() => parseJudgeArtifact(fenced(innerObjectOnly), envelope)).toThrow();
  });

  it("a repair that yields valid JSON of the WRONG shape still throws", () => {
    expect(() => parseJudgeArtifact(fenced(`{"narrative": "no tools key",}`), envelope)).toThrow();
  });
});
