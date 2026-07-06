import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractComponents } from "./extract-components.js";
import { textModel, countingModel } from "../test-helpers.js";

const INCLUDE = JSON.stringify({
  include: true,
  reason: "primitive",
  name: "Badge",
  description: "A small status badge.",
  imports: ["Badge"],
  props: [{ name: "text", type: "string", optional: false, description: "Badge text." }],
  jsx: "<Badge>{p.text}</Badge>",
});
const EXCLUDE = JSON.stringify({
  include: false, reason: "page-level", name: "Page", description: "n/a", imports: [], props: [], jsx: "<div />",
});

describe("extractComponents", () => {
  it("writes descriptor/impl pairs for included components plus entry + vite config", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "comp-"));
    await mkdir(path.join(dir, "src/components/ui"), { recursive: true });
    // Realistic tsconfig: glob strings must not defeat the paths read
    await writeFile(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } }, include: ["**/*.ts", "**/*.tsx"] }),
    );
    await writeFile(path.join(dir, "src/components/ui/badge.tsx"), "export const Badge = () => null");
    await writeFile(path.join(dir, "src/components/ui/panel.tsx"), "export const Panel = () => null");
    const summary = await extractComponents(dir, textModel([INCLUDE, EXCLUDE]), { force: false });
    expect(summary.written).toEqual(["Badge"]);
    expect(summary.excluded).toHaveLength(1);
    await readFile(path.join(dir, ".vendo/components/Badge/descriptor.ts"), "utf8");
    await readFile(path.join(dir, ".vendo/components/Badge/impl.tsx"), "utf8");
    await readFile(path.join(dir, ".vendo/components/entry.ts"), "utf8");
    const viteConfig = await readFile(path.join(dir, ".vendo/components/vite.config.mts"), "utf8");
    expect(viteConfig).toContain('"@": path.resolve(here, "../../src")');
  });

  it("repairs a broken wrapper once by feeding the codegen error back", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "comp-"));
    await mkdir(path.join(dir, "src/components/ui"), { recursive: true });
    await writeFile(path.join(dir, "src/components/ui/badge.tsx"), "export const Badge = () => null");
    const BROKEN = JSON.stringify({
      include: true, reason: "primitive", name: "Badge", description: "A badge.",
      imports: ["Badge"], props: [{ name: "text", type: "string", optional: false, description: "Text." }],
      jsx: "<Badge>{p.text}</Badge", // syntax error
    });
    const summary = await extractComponents(dir, textModel([BROKEN, INCLUDE]), { force: false });
    expect(summary.written).toEqual(["Badge"]);
    expect(summary.failed).toEqual([]);
  });

  // Syntax-valid but degenerate: an enum prop with no values compiles to
  // z.enum([]), which rejects every render at runtime. The old syntax-only
  // rescue passed this through; the schema rescue catches it.
  const EMPTY_ENUM = JSON.stringify({
    include: true, reason: "primitive", name: "Badge", description: "A badge.",
    imports: ["Badge"], props: [{ name: "status", type: "enum", enumValues: [], optional: false, description: "Status." }],
    jsx: "<Badge>{p.status}</Badge>",
  });

  it("repairs a degenerate empty-enum schema once via the round-trip", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "comp-"));
    await mkdir(path.join(dir, "src/components/ui"), { recursive: true });
    await writeFile(path.join(dir, "src/components/ui/badge.tsx"), "export const Badge = () => null");
    const { model, count } = countingModel([EMPTY_ENUM, INCLUDE]);
    const summary = await extractComponents(dir, model, { force: false });
    expect(summary.written).toEqual(["Badge"]);
    expect(summary.failed).toEqual([]);
    expect(count()).toBe(2); // original call + exactly one repair round-trip
    await readFile(path.join(dir, ".vendo/components/Badge/descriptor.ts"), "utf8");
  });

  it("reports a never-fixing degenerate schema as failed and writes nothing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "comp-"));
    await mkdir(path.join(dir, "src/components/ui"), { recursive: true });
    await writeFile(path.join(dir, "src/components/ui/badge.tsx"), "export const Badge = () => null");
    const { model, count } = countingModel([EMPTY_ENUM, EMPTY_ENUM]);
    const summary = await extractComponents(dir, model, { force: false });
    expect(summary.written).toEqual([]);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]!.error).toMatch(/degenerate/);
    expect(count()).toBe(2); // one repair attempt, then give up — never a second retry
    await expect(readFile(path.join(dir, ".vendo/components/Badge/descriptor.ts"), "utf8")).rejects.toThrow();
  });
});
