import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as chrome from "../../src/chrome/index.js";

// Shelf-core Task 1 guard: the thread refactor (vendo-thread.tsx →
// chrome/thread/) must keep `@vendoai/ui/chrome`'s public surface identical.
// Value exports are asserted at runtime; type-only exports are erased by
// esbuild, so — following packages/vendo/src/type-surface.test.ts — a real
// `tsc --noEmit` runs over a generated fixture that `import type`s each name
// from the source chrome entry (a dropped type re-export emits TS2305).

const VALUE_EXPORTS = [
  "ActivityPanel",
  "ApprovalCard",
  "AutomationsPanel",
  "ConnectCard",
  "ConnectedAccountsPanel",
  "NoPolicyNotice",
  "VendoOverlay",
  "VendoPage",
  "VendoPalette",
  "VendoSlot",
  "VendoThread",
  "VendoToasts",
  "vendoToast",
  "dismissAllVendoToasts",
  "WaitingQueue",
  "VendoStage",
  // Shelf Task 4 — the conversation-opening registry seam (slot remix,
  // triggers, palette defaults all route through it).
  "openVendoConversation",
  // Shelf Lane B — the two placeable pieces (ui-usage-dx §2).
  "VendoActivities",
  "VendoTrigger",
  // The eject surface (§4 customization ladder): internals the ejected
  // thread compiles against, exported deliberately so ejected chrome keeps
  // data/wire logic as a package dependency and only forks pixels.
  "describeActivity",
  "formatAuditTime",
  "outcomeLabel",
  "BuildBeat",
  "StatusRibbon",
  "toolPresentation",
  "ChromeRoot",
  "useCopyFeedback",
  "ConnectDockButton",
  "ConnectTray",
  "FluidThinking",
  "previewArgs",
  "toolTitle",
  "Markdown",
  "MorphToast",
  "PrefillScopeContext",
  "registerPrefillConsumer",
  "LONG_TEXT_CAP",
  "truncateHead",
  // Discoverability (ui-usage-dx §6) — the built-in greeting fallback (so
  // hosts can extend rather than replace it) plus the fire-once store, which
  // the ejected thread template imports (the eject standalone guard requires
  // every template import to be public).
  "defaultVendoGreeting",
  "hasSeen",
  "markSeen",
] as const;

const TYPE_EXPORTS = [
  "ApprovalCardProps",
  "ConnectCardProps",
  "VendoOverlayProps",
  "VendoCommand",
  "HotkeyChord",
  "PaletteHotkey",
  "VendoToastsProps",
  "VendoToastInput",
  "VendoToastAction",
  "WaitingQueueProps",
  "OpenConversationOptions",
  "VendoActivitiesProps",
  "VendoTriggerProps",
  // Eject surface types.
  "VendoThreadProps",
  "MorphToastProps",
  "OutcomeTone",
  // Discoverability (ui-usage-dx §6) — the dial + greeting config shapes.
  "VendoDiscoverability",
  "VendoGreeting",
];

// vitest's jsdom environment rewrites import.meta.url to a non-file scheme,
// so resolve from the run cwd (vitest runs with cwd = the package root).
const packageDir = process.cwd(); // packages/ui
const require = createRequire(join(packageDir, "package.json"));
const tsc = require.resolve("typescript/bin/tsc");

const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { force: true });
});

/** Type-check a fixture that `import type`s `names` from the chrome entry.
 *  Returns tsc's combined output on failure, or null when it exits clean. */
function typecheckImports(names: string[]): string | null {
  const fixturePath = join(packageDir, `.chrome-surface.${process.pid}.${Math.random().toString(36).slice(2)}.ts`);
  fixtures.push(fixturePath);
  writeFileSync(fixturePath, `import type { ${names.join(", ")} } from "./src/chrome/index.js";\n`);
  try {
    execFileSync(
      process.execPath,
      [tsc, fixturePath, "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext",
        "--moduleResolution", "Bundler", "--skipLibCheck", "--esModuleInterop", "--jsx", "react-jsx"],
      { cwd: packageDir, stdio: "pipe" },
    );
    return null;
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer };
    return `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`;
  }
}

describe("@vendoai/ui/chrome export surface", () => {
  it("exports every shipped chrome value", () => {
    for (const name of VALUE_EXPORTS) {
      expect(chrome[name], name).toBeDefined();
    }
  });

  it("exports no unexpected values", () => {
    expect(Object.keys(chrome).sort()).toEqual([...VALUE_EXPORTS].sort());
  });

  it("re-exports every chrome type from the source entry", () => {
    const failure = typecheckImports(TYPE_EXPORTS);
    expect(failure, failure ?? "").toBeNull();
  });

  it("has teeth: a missing type re-export fails the tsc gate with TS2305", () => {
    const failure = typecheckImports(["__DefinitelyNotAChromeExport"]);
    expect(failure).not.toBeNull();
    expect(failure).toContain("TS2305");
  });
});
