import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Output } from "../../src/cli/shared.js";
import { runSyncFlow, type SyncFlowOptions, type SyncFlowResult } from "../../src/cli/sync-flow.js";

/**
 * `.vendo/fonts.css` and the `typography.fonts` that ADVERTISES it are one
 * fact in two files. A reconcile that moves one without the other leaves the
 * host shipping a sheet its own theme misdescribes — so both are pinned here
 * through the real flow, on a real rebrand.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const REPORT = {
  tools: { added: [], removed: [], changed: [] },
  breaking: [],
  pins: { captured: [], drifted: [] },
  remixableErrors: [],
  catalog: { discovered: 0, registered: 0 },
  components: { captured: [], drifted: [] },
  toolSchemas: { total: 0, inputs: { known: 0, unknown: [] }, outputs: { known: 0, unknown: [] } },
  warnings: [],
};
const scan = (async () => REPORT) as never;
const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

function flow(options: Partial<SyncFlowOptions> & { root: string; output: Output }): Promise<SyncFlowResult> {
  return runSyncFlow({ mode: "incremental", interactive: false, yes: false, sync: scan, ai: false, fetchImpl: offline, ...options });
}

const silent: Output = { log: () => undefined, error: () => undefined };

/** A woff2 the host really ships, reachable through its own `@font-face` — so
 *  resolution stays on disk and never reaches the network. */
async function hostShipping(family: string, weight: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-fonts-reconcile-"));
  dirs.push(root);
  await mkdir(join(root, ".vendo"), { recursive: true });
  await mkdir(join(root, "app"), { recursive: true });
  await mkdir(join(root, "public", "fonts"), { recursive: true });
  await writeFile(join(root, "public", "fonts", "brand.woff2"), Buffer.from(`wOF2-${family}`, "utf8"));
  await writeFile(join(root, "app", "layout.tsx"), 'import "./globals.css";\nexport default () => null;\n', "utf8");
  await rebrand(root, family, weight);
  return root;
}

async function rebrand(root: string, family: string, weight: string): Promise<void> {
  await writeFile(join(root, "app", "globals.css"),
    `@font-face { font-family: '${family}'; font-weight: ${weight}; src: url('/fonts/brand.woff2') format('woff2'); }\n`
    + `:root { --primary: #0f766e; --background: #ffffff; --radius: 8px; --font-sans: '${family}', sans-serif; }\n`,
    "utf8");
}

const themeDoc = (fontFamily: string, fonts?: unknown) => ({
  colors: {
    background: "#ffffff", surface: "#f8fafc", text: "#0f172a", muted: "#64748b",
    accent: "#0f766e", accentText: "#ffffff", danger: "#dc2626", border: "#e2e8f0",
  },
  typography: { fontFamily, headingFamily: fontFamily, baseSize: "16px", ...(fonts === undefined ? {} : { fonts }) },
  radius: { small: "4px", medium: "8px", large: "12px" },
  density: "comfortable",
  motion: "full",
});

const writeTheme = (dir: string, theme: unknown) =>
  writeFile(join(dir, ".vendo", "theme.json"), `${JSON.stringify(theme, null, 2)}\n`, "utf8");

/** The base records what the deterministic scan last read, which is what makes
 *  the slot machine-owned and therefore movable by a rebrand. */
const writeBase = (dir: string, slots: Record<string, string>) =>
  writeFile(join(dir, ".vendo", "theme.extracted.json"),
    `${JSON.stringify({ format: "vendo/theme-extracted@1", slots }, null, 2)}\n`, "utf8");

const readTheme = async (dir: string) =>
  JSON.parse(await readFile(join(dir, ".vendo", "theme.json"), "utf8")) as ReturnType<typeof themeDoc>;

const readSheet = (dir: string) => readFile(join(dir, ".vendo", "fonts.css"), "utf8");

describe("a rebrand moves the sheet and the metadata together", () => {
  it("re-advertises the faces the new brand actually resolved", async () => {
    const dir = await hostShipping("Old Face", "400");
    await writeTheme(dir, themeDoc("Old Face, sans-serif",
      [{ family: "Old Face", weight: "400", style: "normal", source: "public" }]));
    await writeBase(dir, { fontFamily: "Old Face, sans-serif", headingFamily: "Old Face, sans-serif" });

    await rebrand(dir, "New Face", "700");
    await flow({ root: dir, output: silent });

    const theme = await readTheme(dir);
    expect(theme.typography.fontFamily).toBe("New Face, sans-serif");
    // The sheet moved; the metadata that describes it must not still name the
    // brand the host just left.
    expect(await readSheet(dir)).toContain("font-family: 'New Face'");
    expect(theme.typography.fonts).toEqual([
      { family: "New Face", weight: "700", style: "normal", source: "public" },
    ]);
  }, 30_000);

  it("clears both when the new brand resolves to no file at all", async () => {
    const dir = await hostShipping("Old Face", "400");
    await writeTheme(dir, themeDoc("Old Face, sans-serif",
      [{ family: "Old Face", weight: "400", style: "normal", source: "public" }]));
    await writeBase(dir, { fontFamily: "Old Face, sans-serif", headingFamily: "Old Face, sans-serif" });
    await flow({ root: dir, output: silent });
    expect(await readSheet(dir)).toContain("Old Face");

    // A system stack names no file — nothing to resolve, and nothing to reach
    // the network for either.
    await writeFile(join(dir, "app", "globals.css"),
      ":root { --primary: #0f766e; --background: #ffffff; --radius: 8px; --font-sans: system-ui, sans-serif; }\n", "utf8");
    await flow({ root: dir, output: silent });

    // Leaving the file behind means the host keeps SHIPPING the brand they just
    // dropped, with a theme that no longer mentions it.
    await expect(readSheet(dir)).rejects.toThrow();
    expect((await readTheme(dir)).typography.fonts).toBeUndefined();
  }, 30_000);
});
