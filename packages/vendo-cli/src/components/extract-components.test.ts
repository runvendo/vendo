import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractComponents } from "./extract-components.js";
import { textModel, countingModel, throwingModel } from "../test-helpers.js";
import type { Interactor, MultiSelectOptions, MultiSelectValue } from "../interact.js";

/** A picker seam that records the options it was shown and replies via `respond`. */
function fakeInteractor(
  respond: (opts: MultiSelectOptions<string>) => string[] | null,
): { interactor: Interactor; calls: MultiSelectOptions<string>[] } {
  const calls: MultiSelectOptions<string>[] = [];
  const interactor: Interactor = {
    async maskedInput() {
      throw new Error("maskedInput not expected in the catalog picker");
    },
    async multiSelect<Value extends MultiSelectValue>(opts: MultiSelectOptions<Value>) {
      calls.push(opts as unknown as MultiSelectOptions<string>);
      return respond(opts as unknown as MultiSelectOptions<string>) as Value[] | null;
    },
  };
  return { interactor, calls };
}

/** A picker seam that fails if opened — proves the picker is never reached. */
const throwingInteractor: Interactor = {
  async maskedInput() {
    throw new Error("no prompt expected");
  },
  async multiSelect() {
    throw new Error("picker must not open");
  },
};

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
    // The repaired (healthy) descriptor is what landed on disk.
    await expect(readFile(path.join(dir, ".vendo/components/Badge/descriptor.ts"), "utf8")).resolves.toContain(
      "z.string()",
    );
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

const PANEL_INCLUDE = JSON.stringify({
  include: true, reason: "primitive", name: "Panel", description: "A container.",
  imports: ["Panel"], props: [{ name: "text", type: "string", optional: false, description: "Body text." }],
  jsx: "<Panel>{p.text}</Panel>",
});
const PROPOSE_BOTH = JSON.stringify({
  proposals: [
    { file: "src/components/ui/badge.tsx", wrappable: true, reason: "Small status primitive." },
    { file: "src/components/ui/panel.tsx", wrappable: true, reason: "Simple container primitive." },
  ],
});

/** Two ui/ candidates (badge, panel). scan sorts ui/ first, then alphabetical. */
async function twoCandidateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "comp-pick-"));
  await mkdir(path.join(dir, "src/components/ui"), { recursive: true });
  await writeFile(path.join(dir, "src/components/ui/badge.tsx"), "export const Badge = () => null");
  await writeFile(path.join(dir, "src/components/ui/panel.tsx"), "export const Panel = () => null");
  return dir;
}

describe("extractComponents catalog picker", () => {
  it("proposes wrappable candidates by name and generates only the picked ones", async () => {
    const dir = await twoCandidateDir();
    // Pick only badge; panel is deselected.
    const { interactor, calls } = fakeInteractor(() => ["src/components/ui/badge.tsx"]);
    // One propose call, then one analyze call (badge only). If analyze ran for
    // panel too there would be a third call.
    const { model, count } = countingModel([PROPOSE_BOTH, INCLUDE]);
    const summary = await extractComponents(dir, model, { force: false, interactive: true, interactor });

    expect(summary.written).toEqual(["Badge"]);
    expect(summary.deselected).toEqual(["Panel"]);
    expect(count()).toBe(2); // propose (1) + analyze the single pick (1); panel never analyzed
    // The picker was shown both candidates, labeled by component NAME (never paths).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.map((o) => o.label)).toEqual(["Badge", "Panel"]);
    expect(calls[0]!.options.map((o) => o.hint)).toEqual(["Small status primitive.", "Simple container primitive."]);
    expect(calls[0]!.initialValues).toEqual([
      "src/components/ui/badge.tsx",
      "src/components/ui/panel.tsx",
    ]);
    expect(calls[0]!.required).toBe(false);
    await readFile(path.join(dir, ".vendo/components/Badge/impl.tsx"), "utf8");
    await expect(readFile(path.join(dir, ".vendo/components/Panel/impl.tsx"), "utf8")).rejects.toThrow();
  });

  it("non-interactive generates every candidate without opening the picker", async () => {
    const dir = await twoCandidateDir();
    // interactive omitted → picker seam must never be consulted; every
    // candidate goes straight through analyze+write (pre-picker behavior).
    const summary = await extractComponents(dir, textModel([INCLUDE, PANEL_INCLUDE]), {
      force: false,
      interactor: throwingInteractor,
    });
    expect(summary.written).toEqual(["Badge", "Panel"]);
    expect(summary.deselected).toBeUndefined();
    expect(summary.pickerCancelled).toBeUndefined();
  });

  it("zero candidates: no proposal call, no picker, no crash", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "comp-empty-"));
    await mkdir(path.join(dir, "src/components/ui"), { recursive: true });
    // No component files → scanComponents returns []. The model must never be
    // called (no wasted proposal) and the picker must never open.
    const summary = await extractComponents(dir, throwingModel("model must not be called"), {
      force: false,
      interactive: true,
      interactor: throwingInteractor,
    });
    expect(summary.written).toEqual([]);
    expect(summary.candidates).toBe(0);
  });

  it("cancelling the picker skips the step and generates nothing", async () => {
    const dir = await twoCandidateDir();
    const { interactor } = fakeInteractor(() => null); // Ctrl-C
    const { model, count } = countingModel([PROPOSE_BOTH]);
    const summary = await extractComponents(dir, model, { force: false, interactive: true, interactor });
    expect(summary.written).toEqual([]);
    expect(summary.pickerCancelled).toBe(true);
    expect(count()).toBe(1); // propose only — nothing analyzed after cancel
  });

  it("empty selection generates nothing but is not a cancel", async () => {
    const dir = await twoCandidateDir();
    const { interactor } = fakeInteractor(() => []); // unchecked everything, submitted
    const { model, count } = countingModel([PROPOSE_BOTH]);
    const summary = await extractComponents(dir, model, { force: false, interactive: true, interactor });
    expect(summary.written).toEqual([]);
    expect(summary.pickerCancelled).toBeUndefined();
    expect(summary.deselected).toEqual(["Badge", "Panel"]);
    expect(count()).toBe(1); // propose only
  });

  it("already-wrapped candidates are filtered out before the picker ever sees them", async () => {
    const dir = await twoCandidateDir();
    const { interactor, calls } = fakeInteractor((o) => o.options.map((x) => x.value));
    const PROPOSE_PANEL = JSON.stringify({
      proposals: [{ file: "src/components/ui/panel.tsx", wrappable: true, reason: "Container primitive." }],
    });
    // Badge is already wrapped → only panel should be proposed/shown.
    const summary = await extractComponents(
      dir,
      textModel([PROPOSE_PANEL, PANEL_INCLUDE]),
      { force: false, interactive: true, interactor },
      ["Badge"],
    );
    expect(summary.written).toEqual(["Panel"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.map((o) => o.label)).toEqual(["Panel"]);
    expect(calls[0]!.options.map((o) => o.label)).not.toContain("Badge");
    expect(summary.excluded).toEqual([
      { file: "src/components/ui/badge.tsx", reason: "already wrapped in .vendo/components/ — kept" },
    ]);
  });

  it("disambiguates duplicate export names with the rel path and caps long hints", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "comp-dup-"));
    await mkdir(path.join(dir, "src/components/ui"), { recursive: true });
    await mkdir(path.join(dir, "src/components/marketing"), { recursive: true });
    // Two files exporting the SAME component name, plus a unique one.
    await writeFile(path.join(dir, "src/components/ui/button.tsx"), "export const Button = () => null");
    await writeFile(path.join(dir, "src/components/marketing/button.tsx"), "export const Button = () => null");
    await writeFile(path.join(dir, "src/components/ui/badge.tsx"), "export const Badge = () => null");

    const longReason = `Long reason: ${"detail ".repeat(30)}end.`; // way past the hint cap
    const PROPOSE = JSON.stringify({
      proposals: [
        { file: "src/components/ui/badge.tsx", wrappable: true, reason: longReason },
        { file: "src/components/ui/button.tsx", wrappable: true, reason: "Primary button." },
        { file: "src/components/marketing/button.tsx", wrappable: true, reason: "Marketing CTA button." },
      ],
    });
    const { interactor, calls } = fakeInteractor(() => []); // selection is irrelevant here
    await extractComponents(dir, textModel([PROPOSE]), { force: false, interactive: true, interactor });

    expect(calls).toHaveLength(1);
    // scan order: ui/ files first (badge, button), then marketing/.
    expect(calls[0]!.options.map((o) => o.label)).toEqual([
      "Badge", // unique name stays bare
      "Button (src/components/ui/button.tsx)",
      "Button (src/components/marketing/button.tsx)",
    ]);
    const hints = calls[0]!.options.map((o) => o.hint!);
    expect(hints[0]!.length).toBeLessThanOrEqual(72);
    expect(hints[0]).toMatch(/…$/);
    expect(hints[1]).toBe("Primary button."); // short hints untouched
  });

  it("propose can exclude a candidate, keeping it out of the picker", async () => {
    const dir = await twoCandidateDir();
    const { interactor, calls } = fakeInteractor((o) => o.options.map((x) => x.value));
    const PROPOSE_MIXED = JSON.stringify({
      proposals: [
        { file: "src/components/ui/badge.tsx", wrappable: true, reason: "Status primitive." },
        { file: "src/components/ui/panel.tsx", wrappable: false, reason: "Layout container — needs children." },
      ],
    });
    const summary = await extractComponents(
      dir,
      textModel([PROPOSE_MIXED, INCLUDE]),
      { force: false, interactive: true, interactor },
    );
    expect(summary.written).toEqual(["Badge"]);
    expect(calls[0]!.options.map((o) => o.label)).toEqual(["Badge"]);
    expect(summary.excluded).toContainEqual({
      file: "src/components/ui/panel.tsx",
      reason: "Layout container — needs children.",
    });
  });
});
