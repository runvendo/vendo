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
import { rewriteTemplateSource, runEject } from "./eject.js";
import { telemetryCapture } from "./telemetry.test-util.js";

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

// A single-file surface living in chrome/ itself: "./sibling.js" is a chrome
// import and "../hooks/…" a root import (different from thread's shape).
const TEMPLATE_ACTIVITIES = `import { describeActivity } from "./activity-semantics.js";
import { ApprovalCard } from "./approval-card.js";
import { useActivity } from "../hooks/use-activity.js";
export function VendoActivities() {
  return null;
}
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
  await mkdir(join(templatesDir, "activities"), { recursive: true });
  await writeFile(
    join(templatesDir, "templates.json"),
    JSON.stringify({
      version: "0.9.9",
      surfaces: {
        thread: {
          description: "The conversation thread: composer, message list, parts, scrolling.",
          component: "VendoThread",
          sourceBase: "chrome/thread",
          sourceDir: "chrome/thread",
          files: ["composer.tsx", "index.tsx", "parts.tsx"],
        },
        activities: {
          description: "The placeable activity piece: approvals queue + recent-runs feed.",
          component: "VendoActivities",
          sourceBase: "chrome",
          files: ["index.tsx"],
        },
      },
    }),
  );
  await writeFile(join(templatesDir, "thread", "index.tsx"), TEMPLATE_INDEX);
  await writeFile(join(templatesDir, "thread", "composer.tsx"), TEMPLATE_COMPOSER);
  await writeFile(join(templatesDir, "thread", "parts.tsx"), TEMPLATE_PARTS);
  await writeFile(join(templatesDir, "activities", "index.tsx"), TEMPLATE_ACTIVITIES);
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

  it("honors a src/ layout the way init does, and hints the @/ alias import", async () => {
    await makeHost({ srcApp: true });
    const { output, logs } = sink();
    expect(await runEject({ targetDir: root, surface: "thread", output })).toBe(0);
    expect(await exists(join(root, "src", "components", "vendo", "thread", "index.tsx"))).toBe(true);
    expect(await exists(join(root, "components"))).toBe(false);
    // A src-layout host imports via its @/ alias, not "./src/…" from the root.
    expect(logs.join("\n")).toContain('from "@/components/vendo/thread"');
    expect(logs.join("\n")).not.toContain("./src/");
  });

  it("keeps an import resolving to exactly the surface directory relative (barrel import)", () => {
    // Devin review BUG_0001: the equality case must match the build-time
    // classifier — "." from inside the surface is intra, not @vendoai/ui/chrome.
    const shape = { sourceBase: "chrome/thread", sourceDir: "chrome/thread" };
    expect(rewriteTemplateSource('import { VendoThread } from ".";\n', shape))
      .toBe('import { VendoThread } from ".";\n');
  });

  it("rewrites side-effect and dynamic imports the same as from-clauses", () => {
    const shape = { sourceBase: "chrome/thread", sourceDir: "chrome/thread" };
    expect(rewriteTemplateSource('import "./chrome-effects.js";\n', shape))
      .toBe('import "./chrome-effects";\n');
    expect(rewriteTemplateSource('const parts = await import("./parts.js");\n', shape))
      .toBe('const parts = await import("./parts");\n');
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

  it("rewrites a chrome-root single-file surface: siblings → chrome subpath, parent → root package", async () => {
    await makeHost();
    const { output, logs } = sink();
    expect(await runEject({ targetDir: root, surface: "activities", output })).toBe(0);
    const source = await readFileUtf8(join(root, "components", "vendo", "activities", "index.tsx"));
    expect(source).toContain('import { describeActivity } from "@vendoai/ui/chrome";');
    expect(source).toContain('import { ApprovalCard } from "@vendoai/ui/chrome";');
    expect(source).toContain('import { useActivity } from "@vendoai/ui";');
    // Swap instruction names the surface's component, not the thread's.
    expect(logs.join("\n")).toContain("VendoActivities");
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

describe("eject telemetry", () => {
  it("tracks command_run eject with ok reflecting the exit code", async () => {
    await makeHost();
    const ok = await telemetryCapture();
    expect(await runEject({ targetDir: root, surface: "thread", output: sink().output, telemetry: ok.telemetry })).toBe(0);
    expect(ok.event("command_run").properties).toMatchObject({ command: "eject", ok: true });
    expect(typeof ok.event("command_run").properties.durationMs).toBe("number");

    const failed = await telemetryCapture();
    expect(await runEject({ targetDir: root, surface: "sidebar", output: sink().output, telemetry: failed.telemetry })).toBe(1);
    expect(failed.event("command_run").properties).toMatchObject({ command: "eject", ok: false, failedStep: "surface" });
    await rm(ok.home, { recursive: true, force: true });
    await rm(failed.home, { recursive: true, force: true });
  });
});
