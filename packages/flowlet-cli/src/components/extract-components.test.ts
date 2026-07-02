import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractComponents } from "./extract-components.js";
import { textModel } from "../test-helpers.js";

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
    await writeFile(path.join(dir, "src/components/ui/badge.tsx"), "export const Badge = () => null");
    await writeFile(path.join(dir, "src/components/ui/panel.tsx"), "export const Panel = () => null");
    const summary = await extractComponents(dir, textModel([INCLUDE, EXCLUDE]), { force: false });
    expect(summary.written).toEqual(["Badge"]);
    expect(summary.excluded).toHaveLength(1);
    await readFile(path.join(dir, ".flowlet/components/Badge/descriptor.ts"), "utf8");
    await readFile(path.join(dir, ".flowlet/components/Badge/impl.tsx"), "utf8");
    await readFile(path.join(dir, ".flowlet/components/entry.ts"), "utf8");
    await readFile(path.join(dir, ".flowlet/components/vite.config.mts"), "utf8");
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
});
