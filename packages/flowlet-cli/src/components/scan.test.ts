import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanComponents } from "./scan.js";

describe("scanComponents", () => {
  it("finds exported PascalCase components under components dirs, skipping tests/pages", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scan-"));
    await mkdir(path.join(dir, "src/components/ui"), { recursive: true });
    await mkdir(path.join(dir, "src/app"), { recursive: true });
    await writeFile(path.join(dir, "src/components/ui/button.tsx"), "export function Button() { return null }");
    await writeFile(path.join(dir, "src/components/ui/badge.tsx"), "export const Badge = () => null");
    await writeFile(path.join(dir, "src/components/ui/button.test.tsx"), "export function ButtonTest() {}");
    await writeFile(path.join(dir, "src/components/ui/helpers.ts"), "export const x = 1"); // not .tsx
    await writeFile(path.join(dir, "src/app/page.tsx"), "export default function Page() { return null }");
    const candidates = await scanComponents(dir);
    expect(candidates.map((c) => c.exportName).sort()).toEqual(["Badge", "Button"]);
    expect(candidates[0]!.relFile).toMatch(/^src\/components\/ui\//);
  });

  it("scans components/ui before other component dirs so the cap keeps primitives", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scan-"));
    await mkdir(path.join(dir, "src/components/aaa"), { recursive: true });
    await mkdir(path.join(dir, "src/components/ui"), { recursive: true });
    await writeFile(path.join(dir, "src/components/aaa/widget.tsx"), "export const Widget = () => null");
    await writeFile(path.join(dir, "src/components/ui/button.tsx"), "export const Button = () => null");
    const candidates = await scanComponents(dir);
    expect(candidates[0]!.exportName).toBe("Button");
  });
});
