import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractTailwindVars } from "./tailwind-config.js";

describe("extractTailwindVars", () => {
  it("flattens theme.extend colors/radius/font into CssVarDecl-shaped entries", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tw-"));
    const cfg = path.join(dir, "tailwind.config.mjs");
    await writeFile(cfg, `export default {
      theme: { extend: {
        colors: { primary: "#123456", surface: { DEFAULT: "#ffffff", dark: "#000000" } },
        borderRadius: { card: "12px" },
        fontFamily: { sans: ["Inter", "sans-serif"] },
      } },
    };`);
    const { vars, error } = await extractTailwindVars(cfg);
    expect(error).toBeNull();
    expect(vars).toContainEqual(expect.objectContaining({ name: "--color-primary", value: "#123456" }));
    expect(vars).toContainEqual(expect.objectContaining({ name: "--color-surface", value: "#ffffff" }));
    expect(vars).toContainEqual(expect.objectContaining({ name: "--radius-card", value: "12px" }));
    expect(vars).toContainEqual(expect.objectContaining({ name: "--font-sans", value: "Inter, sans-serif" }));
  });

  it("reports TS configs as unsupported instead of throwing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tw-"));
    const cfg = path.join(dir, "tailwind.config.ts");
    await writeFile(cfg, "export default {} satisfies unknown;");
    const { vars, error } = await extractTailwindVars(cfg);
    expect(vars).toEqual([]);
    expect(error).toMatch(/TypeScript/);
  });

  it("reports unloadable configs instead of throwing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tw-"));
    const cfg = path.join(dir, "tailwind.config.mjs");
    await writeFile(cfg, "this is not javascript {{{");
    const { vars, error } = await extractTailwindVars(cfg);
    expect(vars).toEqual([]);
    expect(error).toMatch(/could not load/);
  });
});
