import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Client-side extras a fixture bakes into the corpus overlay component.
 * `moduleSource` is inserted at module scope (e.g. umami's Bearer-token fetch
 * shim); `effect` is a call expression run once on mount inside useEffect. */
export interface CorpusOverlayExtras {
  moduleSource?: string;
  effect?: string;
}

const componentName = "VendoCorpusE2e";

/** The client component file e2e prep writes beside the App Router layout. */
export const corpusOverlayBasename = "vendo-corpus-e2e.tsx";

export function corpusOverlaySource(extras: CorpusOverlayExtras = {}): string {
  const useEffectImport = extras.effect === undefined ? "" : 'import { useEffect } from "react";\n';
  const effect = extras.effect === undefined ? "" : `  useEffect(() => ${extras.effect}, []);\n`;
  return `"use client";
${useEffectImport}import { VendoOverlay } from "@vendoai/ui/chrome";
${extras.moduleSource ?? ""}
export function ${componentName}() {
${effect}  return <VendoOverlay />;
}
`;
}

/**
 * `vendo init` wires `<VendoRoot theme={...}>` into the App Router layout but
 * ships no chat chrome — hosts mount `VendoOverlay` themselves (the demo apps
 * do exactly this). The corpus fixtures are hosts too, so e2e prep mounts the
 * overlay via a small client component beside the layout. Fails loudly when
 * the layout does not carry init's VendoRoot wrapper, so the harness surfaces
 * the next init-scaffold drift instead of silently producing a chat-less page.
 */
export async function mountCorpusOverlay(
  appRoot: string,
  appDirRel: string,
  extras: CorpusOverlayExtras = {},
): Promise<void> {
  const appDir = path.join(appRoot, appDirRel);
  await writeFile(path.join(appDir, corpusOverlayBasename), corpusOverlaySource(extras));

  const layoutPath = path.join(appDir, "layout.tsx");
  const source = await readFile(layoutPath, "utf8");
  if (source.includes(componentName)) return;
  if (!source.includes("{children}</VendoRoot>")) {
    throw new Error(
      `Corpus e2e prep expected ${layoutPath} to wrap {children} in VendoRoot (vendo init layout output drifted?)`,
    );
  }
  const next = `import { ${componentName} } from "./vendo-corpus-e2e";\n${source}`
    .replace("{children}</VendoRoot>", `{children}<${componentName} /></VendoRoot>`);
  await writeFile(layoutPath, next);
}
