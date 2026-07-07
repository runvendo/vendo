import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

  it("loads TypeScript configs through esbuild", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tw-"));
    const cfg = path.join(dir, "tailwind.config.ts");
    await writeFile(cfg, `export default {
      theme: { extend: {
        colors: { primary: "hsl(var(--primary))" },
        borderRadius: { lg: "var(--radius)" },
      } },
    } satisfies unknown;`);
    const { vars, error } = await extractTailwindVars(cfg);
    expect(error).toBeNull();
    expect(vars).toContainEqual(expect.objectContaining({ name: "--color-primary", value: "hsl(var(--primary))" }));
    expect(vars).toContainEqual(expect.objectContaining({ name: "--radius-lg", value: "var(--radius)" }));
  });

  it("loads configs that spread tailwindcss/defaultTheme", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tw-"));
    await mkdir(path.join(dir, "node_modules/tailwindcss"), { recursive: true });
    await writeFile(
      path.join(dir, "node_modules/tailwindcss/defaultTheme.js"),
      `const util = require("util");
module.exports = { fontFamily: { sans: ["ui-sans-serif", util.format("%s", "system-ui"), "sans-serif"] } };
`,
    );
    const cfg = path.join(dir, "tailwind.config.ts");
    await writeFile(cfg, `import { fontFamily } from "tailwindcss/defaultTheme";
export default {
  theme: { extend: {
    fontFamily: { sans: ["var(--font-geist-sans)", ...fontFamily.sans] },
  } },
};`);
    const { vars, error } = await extractTailwindVars(cfg);
    expect(error).toBeNull();
    expect(vars).toContainEqual(expect.objectContaining({
      name: "--font-sans",
      value: expect.stringContaining("var(--font-geist-sans), ui-sans-serif"),
    }));
  });

  it("falls back to source parsing for workspace-imported fontFamily arrays", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tw-workspace-"));
    await mkdir(path.join(dir, "apps/web"), { recursive: true });
    await mkdir(path.join(dir, "packages/tailwind-config"), { recursive: true });
    await writeFile(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
    await writeFile(
      path.join(dir, "packages/tailwind-config/package.json"),
      JSON.stringify({ name: "@acme/tailwind-config" }),
    );
    await writeFile(
      path.join(dir, "packages/tailwind-config/tailwind.config.ts"),
      `export default {
  theme: { extend: {
    fontFamily: { default: ["var(--font-inter)", "system-ui", "sans-serif"] },
  } },
};`,
    );
    const cfg = path.join(dir, "apps/web/tailwind.config.ts");
    await writeFile(
      cfg,
      `import sharedConfig from "@acme/tailwind-config/tailwind.config";
export default {
  ...sharedConfig,
  theme: { extend: { fontFamily: { sans: ["var(--font-geist-sans)", ...fontFamily.sans] } } },
};`,
    );

    const { vars, error } = await extractTailwindVars(cfg);
    expect(error).toMatch(/could not load/);
    expect(vars).toContainEqual(expect.objectContaining({
      name: "--font-default",
      value: "var(--font-inter), system-ui, sans-serif",
    }));
    expect(vars).toContainEqual(expect.objectContaining({
      name: "--font-sans",
      value: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
    }));
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
