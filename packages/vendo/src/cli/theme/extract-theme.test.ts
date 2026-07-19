import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractTheme } from "./extract-theme.js";

const cleanup: string[] = [];
const appsDir = fileURLToPath(new URL("../../../../../apps/", import.meta.url));

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

function themeModel(answer: unknown, prompts?: string[]): LanguageModel {
  return new MockLanguageModelV3({
    doGenerate: async (request) => {
      const promptText = JSON.stringify(request.prompt);
      if (prompts) prompts.push(promptText);
      return {
        content: [{ type: "text", text: JSON.stringify(answer) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: ZERO_USAGE,
        warnings: [],
      };
    },
  }) as LanguageModel;
}

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-theme-"));
  cleanup.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

describe("extractTheme allowlist fast-path", () => {
  it("reads a fully conventional shadcn sheet exactly, with zero model calls", async () => {
    const root = await fixture({
      "package.json": "{}\n",
      "app/layout.tsx": 'import "./globals.css";\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n',
      "app/globals.css": `
        :root {
          --background: #fafafa;
          --foreground: oklch(0.205 0 0);
          --card: 0 0% 100%;
          --primary: hsl(262 83% 58%);
          --primary-foreground: #ffffff;
          --muted-foreground: #737373;
          --border: #dedede;
          --destructive: #b91c1c;
          --radius: 0.625rem;
          --font-sans: Inter, sans-serif;
          --font-heading: Newsreader, serif;
          --density: compact;
          --motion: reduced;
        }
        .dark { --background: #09090b; --foreground: #fafafa; }
      `,
    });
    const resolveModel = vi.fn(async () => themeModel({ slots: {} }));

    const result = await extractTheme(root, { resolveModel });

    expect(resolveModel).not.toHaveBeenCalled();
    expect(result.usedModel).toBe(false);
    expect(result.slots).toMatchObject({
      background: "#fafafa",
      text: "#171717",
      surface: "#ffffff",
      accent: "#7c3bed",
      accentText: "#ffffff",
      mutedText: "#737373",
      border: "#dedede",
      danger: "#b91c1c",
      radius: "10px",
      fontFamily: "Inter, sans-serif",
      headingFamily: "Newsreader, serif",
      density: "compact",
      motion: "reduced",
    });
    expect(result.matched["accent"]).toBe("--primary");
    expect(result.defaulted).toEqual(["baseSize"]);
    expect(result.hasDarkVariant).toBe(true);
  });

  it("accepts the Tailwind-v4 --color-* spellings, !important noise, and @import chains", async () => {
    const root = await fixture({
      "package.json": "{}\n",
      "app/layout.tsx": 'import "./global.css";\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n',
      "app/global.css": '@import "./tokens.css";\n',
      "app/tokens.css": `
        @theme {
          --color-background: #ffffff;
          --color-foreground: #111827;
          --color-primary: #2b7fff !important;
          --color-border: #e5e7eb;
        }
      `,
    });

    const result = await extractTheme(root);

    expect(result.slots).toMatchObject({
      background: "#ffffff",
      text: "#111827",
      accent: "#2b7fff",
      border: "#e5e7eb",
      // No accent-text token: derived by the larger WCAG contrast ratio.
      accentText: "#000000",
    });
    expect(result.matched["accentText"]).toBe("(contrast) accent");
    expect(result.usedModel).toBe(false);
  });

  it("derives accentText without a model call when every other core token is exact", async () => {
    const root = await fixture({
      "package.json": "{}\n",
      "app/layout.tsx": 'import "./globals.css";\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n',
      // Everything brand-defining except --primary-foreground: accentText is
      // a derivation, never a reason to spend a model call.
      "app/globals.css": `
        :root {
          --background: #ffffff;
          --foreground: #111827;
          --card: #f9fafb;
          --primary: #1d4ed8;
          --muted-foreground: #6b7280;
          --border: #e5e7eb;
          --destructive: #b91c1c;
          --radius: 8px;
          --font-sans: Inter, sans-serif;
        }
      `,
    });
    const resolveModel = vi.fn(async () => themeModel({ slots: {} }));

    const result = await extractTheme(root, { resolveModel });

    expect(resolveModel).not.toHaveBeenCalled();
    expect(result.slots.accentText).toBe("#ffffff");
    expect(result.matched["accentText"]).toBe("(contrast) accent");
  });

  it("never claims a non-conventional token: unknown names go to defaults, reported", async () => {
    const root = await fixture({
      "package.json": "{}\n",
      "app/layout.tsx": 'import "./globals.css";\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n',
      // A custom token set (Cadence-style names): nothing here is on the
      // allowlist, so with no model every slot defaults — visibly.
      "app/globals.css": ":root { --color-ink: #111111; --color-line: #ecebe8; --color-evergreen-600: #196b46; }\n",
    });

    const result = await extractTheme(root);

    expect(result.slots.accent).toBe("#2563eb");
    expect(result.defaulted).toEqual(expect.arrayContaining([
      "accent", "background", "surface", "text", "mutedText", "border", "danger", "fontFamily",
    ]));
    expect(result.usedModel).toBe(false);
  });
});

describe("extractTheme LLM pass", () => {
  const CUSTOM_TOKEN_APP = {
    "package.json": "{}\n",
    "app/layout.tsx": [
      'import { Inter } from "next/font/google";',
      'import "./globals.css";',
      'const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });',
      "export default function Layout({ children }) { return <html className={inter.variable}><body>{children}</body></html>; }",
    ].join("\n"),
    "app/globals.css": `
      :root {
        --border: #ecebe8;
        --color-ink: #111111;
        --color-bg: #fbfbfa;
        --font-sans: var(--font-inter);
      }
    `,
  };

  it("asks the model once for the slots the allowlist could not read, and merges", async () => {
    const prompts: string[] = [];
    const resolveModel = vi.fn(async () => themeModel({
      slots: {
        accent: "#111111",
        background: "#fbfbfa",
        surface: "#ffffff",
        text: "#111111",
        mutedText: "#908c85",
        danger: "#b0473a",
        radius: "8px",
        fontFamily: "Inter, sans-serif",
        // Exact reads are authoritative: this must NOT override --border.
        border: "#ff0000",
      },
    }, prompts));

    const result = await extractTheme(await fixture(CUSTOM_TOKEN_APP), { resolveModel });

    expect(resolveModel).toHaveBeenCalledTimes(1);
    expect(result.usedModel).toBe(true);
    expect(result.slots).toMatchObject({
      accent: "#111111",
      background: "#fbfbfa",
      surface: "#ffffff",
      mutedText: "#908c85",
      danger: "#b0473a",
      fontFamily: "Inter, sans-serif",
      headingFamily: "Inter, sans-serif",
      border: "#ecebe8",
    });
    expect(result.matched["border"]).toBe("--border");
    expect(result.matched["accent"]).toBe("(model)");
    expect(result.matched["headingFamily"]).toBe("(inherit) fontFamily");
    // The single call carries the evidence: layout + css, and the needed slots.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("globals.css");
    expect(prompts[0]).toContain("next/font/google");
  });

  it("surfaces model-flagged uncertainty and drops invalid model values", async () => {
    const resolveModel = async () => themeModel({
      slots: {
        accent: "#196b46",
        surface: "not-a-color",
        radius: "calc(1px + 1rem)",
      },
      uncertain: [
        { slot: "accent", note: "green appears only in data accents" },
        { slot: "mutedText", note: "two plausible muted inks" },
        // Uncertainty about an exact-read slot is moot, and unknown slots drop.
        { slot: "border", note: "moot — read exactly from --border" },
        { slot: "not-a-slot", note: "ignored" },
      ],
    });

    const result = await extractTheme(await fixture(CUSTOM_TOKEN_APP), { resolveModel });

    expect(result.slots.accent).toBe("#196b46");
    expect(result.slots.surface).toBe("#f8fafc");
    expect(result.slots.radius).toBe("8px");
    expect(result.defaulted).toContain("surface");
    expect(result.uncertain).toEqual([
      { slot: "accent", note: "green appears only in data accents" },
      { slot: "mutedText", note: "two plausible muted inks" },
    ]);
  });

  it("degrades to reported defaults when no model resolves — never a silent guess", async () => {
    const result = await extractTheme(await fixture(CUSTOM_TOKEN_APP), {
      resolveModel: async () => { throw new Error("no model configured"); },
    });

    expect(result.usedModel).toBe(false);
    expect(result.errors.join("\n")).toContain("no model configured");
    expect(result.slots.accent).toBe("#2563eb");
    expect(result.defaulted).toContain("accent");
    // The one exact read still lands.
    expect(result.slots.border).toBe("#ecebe8");
  });
});

describe("extractTheme demo-app allowlist behavior (deterministic)", () => {
  it("Maple: exact reads claim only true conventional tokens — no wrong-brand exacts", async () => {
    const result = await extractTheme(join(appsDir, "demo-bank"));
    // Maple declares --color-border (allowlist) = #ECEBE8; its custom ink/bg
    // tokens are NOT claimed — they default without a model, visibly.
    expect(result.slots.border).toBe("#ecebe8");
    expect(result.matched["border"]).toBe("--color-border");
    expect(result.defaulted).toEqual(expect.arrayContaining(["accent", "background", "text", "mutedText"]));
  });

  it("Cadence: only the true conventional token is exact-claimed (--color-card), never --color-surface", async () => {
    const result = await extractTheme(join(appsDir, "demo-accounting"));
    // Cadence's --color-card #ffffff IS the shadcn card convention — a
    // correct exact read. Its --color-surface is the PAGE background, and
    // "surface" is not a shadcn name, so no exact pass may claim it: the
    // background slot stays default (visible), not silently wrong.
    expect(result.matched["surface"]).toBe("--color-card");
    expect(result.slots.surface).toBe("#ffffff");
    expect(result.defaulted).toEqual(expect.arrayContaining(["accent", "background", "text", "mutedText", "border"]));
  });
});
