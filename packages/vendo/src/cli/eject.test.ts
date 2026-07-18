/**
 * `vendo eject <surface>` — shadcn-style: copy a shipped chrome surface's
 * presentation source out of the installed @vendoai/ui into the host repo as
 * code the developer owns (§4 customization ladder, eject rung). Pixels are
 * copied; data/wire logic keeps resolving from @vendoai/ui, which is why the
 * copy rewrites the templates' package-internal relative imports to the
 * public subpaths.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exists, type Output } from "./shared.js";
import { runEject } from "./eject.js";

function sink(): { output: Output; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    output: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vendo-eject-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const TEMPLATE_INDEX = `/**
 * Ejected from @vendoai/ui v0.9.9 — yours to edit.
 */
import { useVendoThread } from "../../hooks/use-vendo-thread.js";
import { ChromeRoot, MorphToast, type MorphToastProps } from "../chrome-root.js";
import { Composer } from "./composer.js";
export function VendoThread() {
  return null;
}
`;

const TEMPLATE_COMPOSER = `import { PrefillScopeContext } from "../overlay-registry.js";
export const Composer = () => null;
`;

const TEMPLATE_PARTS = `import { PayloadView } from "../../tree/renderer.js";
import {
  appTitle,
  toolName,
} from "./message-data.js";
export const parts = [PayloadView, appTitle, toolName];
`;

/** A host repo with @vendoai/ui "installed" (fixture dist + eject templates). */
async function makeHost(options: { srcApp?: boolean } = {}): Promise<void> {
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "host", private: true }));
  const appDir = options.srcApp === true ? join(root, "src", "app") : join(root, "app");
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "page.tsx"), "export default function Page() { return null; }\n");

  const uiDir = join(root, "node_modules", "@vendoai", "ui");
  const templatesDir = join(uiDir, "dist", "eject-templates");
  await mkdir(join(templatesDir, "thread"), { recursive: true });
  await writeFile(
    join(uiDir, "package.json"),
    JSON.stringify({ name: "@vendoai/ui", version: "0.9.9", main: "./dist/index.js" }),
  );
  await writeFile(join(uiDir, "dist", "index.js"), "export {};\n");
  await writeFile(
    join(templatesDir, "templates.json"),
    JSON.stringify({
      version: "0.9.9",
      surfaces: {
        thread: {
          description: "The conversation thread: composer, message list, parts, scrolling.",
          files: ["composer.tsx", "index.tsx", "parts.tsx"],
        },
      },
    }),
  );
  await writeFile(join(templatesDir, "thread", "index.tsx"), TEMPLATE_INDEX);
  await writeFile(join(templatesDir, "thread", "composer.tsx"), TEMPLATE_COMPOSER);
  await writeFile(join(templatesDir, "thread", "parts.tsx"), TEMPLATE_PARTS);
}

describe("runEject", () => {
  it("copies the surface into components/vendo/<surface> and stamps the manifest", async () => {
    await makeHost();
    const { output } = sink();
    const code = await runEject({ targetDir: root, surface: "thread", output });
    expect(code).toBe(0);
    const dir = join(root, "components", "vendo", "thread");
    for (const file of ["index.tsx", "composer.tsx", "parts.tsx"]) {
      expect(await exists(join(dir, file)), `${file} missing`).toBe(true);
    }
    const manifest = JSON.parse(await readFile(join(dir, ".vendo-eject.json"), "utf8")) as {
      surface: string;
      version: string;
    };
    expect(manifest.surface).toBe("thread");
    expect(manifest.version).toBe("0.9.9");
  });

  it("honors a src/ layout the way init does", async () => {
    await makeHost({ srcApp: true });
    const { output } = sink();
    expect(await runEject({ targetDir: root, surface: "thread", output })).toBe(0);
    expect(await exists(join(root, "src", "components", "vendo", "thread", "index.tsx"))).toBe(true);
    expect(await exists(join(root, "components"))).toBe(false);
  });

  it("rewrites package-internal imports to public subpaths and keeps intra-surface imports relative", async () => {
    await makeHost();
    const { output } = sink();
    await runEject({ targetDir: root, surface: "thread", output });
    const dir = join(root, "components", "vendo", "thread");

    const index = await readFile(join(dir, "index.tsx"), "utf8");
    expect(index).toContain('import { useVendoThread } from "@vendoai/ui";');
    expect(index).toContain(
      'import { ChromeRoot, MorphToast, type MorphToastProps } from "@vendoai/ui/chrome";',
    );
    expect(index).toContain('import { Composer } from "./composer";');

    const composer = await readFileUtf8(join(dir, "composer.tsx"));
    expect(composer).toContain('import { PrefillScopeContext } from "@vendoai/ui/chrome";');

    const parts = await readFileUtf8(join(dir, "parts.tsx"));
    expect(parts).toContain('import { PayloadView } from "@vendoai/ui/tree";');
    // Multiline import clauses rewrite too: the from-specifier drops its .js.
    expect(parts).toContain('} from "./message-data";');

    // No template escapes the rewrite: relative specifiers never keep .js.
    for (const source of [index, composer, parts]) {
      expect(source).not.toMatch(/from\s+["']\.[^"']*\.js["']/);
      expect(source).not.toMatch(/from\s+["']\.\./);
    }
  });

  it("refuses to overwrite an existing ejected dir without --force", async () => {
    await makeHost();
    const { output } = sink();
    await runEject({ targetDir: root, surface: "thread", output });
    const indexPath = join(root, "components", "vendo", "thread", "index.tsx");
    await writeFile(indexPath, "// my edits\n");

    const second = sink();
    const code = await runEject({ targetDir: root, surface: "thread", output: second.output });
    expect(code).toBe(1);
    expect(second.errors.join("\n")).toContain("--force");
    expect(await readFileUtf8(indexPath)).toBe("// my edits\n");

    const forced = sink();
    expect(await runEject({ targetDir: root, surface: "thread", force: true, output: forced.output })).toBe(0);
    expect(await readFileUtf8(indexPath)).not.toBe("// my edits\n");
  });

  it("prints the two-line swap instruction after ejecting", async () => {
    await makeHost();
    const { output, logs } = sink();
    await runEject({ targetDir: root, surface: "thread", output });
    const text = logs.join("\n");
    expect(text).toContain("components/vendo/thread");
    expect(text).toContain('import { VendoThread } from');
    expect(text).toContain("<VendoOverlay thread={VendoThread}");
  });

  it("--list shows the ejectable surfaces from the installed package", async () => {
    await makeHost();
    const { output, logs } = sink();
    expect(await runEject({ targetDir: root, list: true, output })).toBe(0);
    const text = logs.join("\n");
    expect(text).toContain("thread");
    expect(text).toContain("conversation thread");
  });

  it("rejects an unknown surface, naming the available ones", async () => {
    await makeHost();
    const { output, errors } = sink();
    expect(await runEject({ targetDir: root, surface: "sidebar", output })).toBe(1);
    expect(errors.join("\n")).toContain("sidebar");
    expect(errors.join("\n")).toContain("thread");
  });
});

async function readFileUtf8(path: string): Promise<string> {
  return readFile(path, "utf8");
}
