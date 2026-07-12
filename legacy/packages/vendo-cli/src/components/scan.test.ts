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

  it("recognizes shadcn `export { Button }` re-exports and `export { X as Y }`, skipping lowercase utils", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scan-"));
    await mkdir(path.join(dir, "src/components/ui"), { recursive: true });
    await writeFile(
      path.join(dir, "src/components/ui/button.tsx"),
      `import * as React from "react"
const Button = React.forwardRef((props, ref) => null)
const buttonVariants = () => ""
export { Button, buttonVariants }`,
    );
    await writeFile(
      path.join(dir, "src/components/ui/alert.tsx"),
      `const AlertImpl = () => null
export { AlertImpl as Alert }`,
    );
    const candidates = await scanComponents(dir);
    const byFile = Object.fromEntries(candidates.map((c) => [c.relFile, c]));
    const button = byFile["src/components/ui/button.tsx"]!;
    expect(button).toBeDefined();
    expect(button.exportName).toBe("Button");
    expect(button.exportNames).toContain("Button");
    expect(button.exportNames).not.toContain("buttonVariants"); // lowercase util skipped
    const alert = byFile["src/components/ui/alert.tsx"]!;
    expect(alert.exportName).toBe("Alert"); // the `X as Y` exported name
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
