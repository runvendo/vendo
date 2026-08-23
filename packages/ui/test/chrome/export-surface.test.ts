import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import * as chrome from "../../src/chrome/index.js";

// Shelf-core Task 1 guard: the thread refactor (vendo-thread.tsx →
// chrome/thread/) must keep `@vendoai/ui/chrome`'s public surface identical.
// Value exports are asserted at runtime; type-only exports are erased by
// esbuild, so — following packages/vendo/src/type-surface.test.ts — a real
// `tsc --noEmit` runs over a generated fixture that `import type`s each name
// from the source chrome entry (a dropped type re-export emits TS2305).

const VALUE_EXPORTS = [
  // The window label the automation card shares with the automations wire.
  "sponsorLabel",
  "ApprovalCard",
  "AutomationCard",
  "ConnectCard",
  "GrantSetCard",
  // #1090 — the asks→rows mapping the thread consent surface shares with any
  // host surface, public because the thread eject template imports it.
  "grantSetPermissions",
  // Build contract §9.4 — the viewer fork offer.
  "ForkOffer",
  "encodeGrantPrincipal",
  "NoPolicyNotice",
  "VendoOverlay",
  "VendoPalette",
  "VendoSlot",
  // Existing-agents Lane B — the three BYO-chat embeds.
  "VendoAppEmbed",
  "VendoApprovalEmbed",
  "VendoToolResult",
  "VendoThread",
  "VendoToasts",
  "vendoToast",
  "dismissAllVendoToasts",
  // Shelf Task 4 — the conversation-opening registry seam (slot remix,
  // triggers, palette defaults all route through it).
  "openVendoConversation",
  // Keystone graduates B8 — the pin ceremony. `usePinAction` is what every pin
  // affordance calls; `playPinCeremony` is the same sequence for a host running
  // a pin from its own control.
  "playPinCeremony",
  "usePinAction",
  // ⚠️ TEST EDIT — `usePinNudge` joins them DELIBERATELY. The thread is an eject
  // surface, so every import in `thread/parts.tsx` is public API by
  // construction, and the pin button there needs its invite state. The action
  // and the invitation are two halves of one affordance: a host that ejects the
  // template and keeps the pin needs both or its pin goes quiet.
  "usePinNudge",
  // ⚠️ TEST EDIT — placement is public for the SAME reason `usePinNudge` is:
  // the thread card's bar renders `PlacementAction`, and every import in
  // `thread/parts.tsx` is public API by construction. `AddToPicker` is the menu
  // half on its own, for a surface that only ever wants the choice. (Their
  // destinations come from `useSlots`, which the root surface exports.)
  "AddToPicker",
  "PlacementAction",
  // ⚠️ TEST EDIT — `useApprovalModal` joins them DELIBERATELY, for the same
  // reason as the two above: `thread/parts.tsx` now mounts the approval modal
  // per app card (a parked press must be able to ask its question in the chat),
  // and every import in that eject template is public API by construction.
  "useApprovalModal",
  "VendoTrigger",
  // Keystone graduates B7 — the remixable-surface affordance.
  "Remixable",
  // The eject surface (§4 customization ladder): internals the ejected
  // thread compiles against, exported deliberately so ejected chrome keeps
  // data/wire logic as a package dependency and only forks pixels.
  "BuildBeat",
  // Spec §1 (2026-08-03) — the settled turn's summary row. Public because the
  // ejected thread template renders it (the eject standalone guard requires
  // every template import to be part of the chrome surface).
  "BeatSummary",
  // 2026-07 loading-state audit — the between-steps busy voice, now a beat at
  // the transcript tail rather than a pill above the composer; the ejected
  // thread template renders it, so it must be public (eject standalone rule).
  "WorkingBeat",
  "toolPresentation",
  // 2026-07 split-view workspace — the overlay's expand/collapse machine;
  // the ejected thread's app cards read the context via useSplitView.
  "SplitViewContext",
  "useSplitView",
  "ChromeRoot",
  "useCopyFeedback",
  "ConnectDockButton",
  "ConnectTray",
  "FluidThinking",
  "previewArgs",
  "toolkitDisplayName",
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
  // ui-lane-cards picks — the mobile approval sheet (1-H) and the morph's
  // Activity-dock seam (4-C): the anchor attribute a host stamps and the
  // bump event its badge listens for.
  "ApprovalSheet",
  "ACTIVITY_ANCHOR_ATTRIBUTE",
  "ACTIVITY_BUMP_EVENT",
] as const;

const TYPE_EXPORTS = [
  "ApprovalCardProps",
  "AutomationCardProps",
  "ConnectCardProps",
  "GrantSetCardProps",
  "GrantSetPermission",
  "ForkOfferProps",
  "VendoOverlayProps",
  "VendoCommand",
  "HotkeyChord",
  "PaletteHotkey",
  "VendoToastsProps",
  "VendoToastInput",
  "VendoToastAction",
  "OpenConversationOptions",
  "VendoTriggerProps",
  // 2026-08-02 final shape: RemixContext died with the context-chip behavior
  // (remix always means fork now) — deliberately absent.
  "RemixableProps",
  // Eject surface types.
  "VendoThreadProps",
  "MorphToastProps",
  // Discoverability (ui-usage-dx §6) — the dial + greeting config shapes.
  "VendoDiscoverability",
  "VendoGreeting",
];

// vitest's jsdom environment rewrites import.meta.url to a non-file scheme,
// so resolve from the run cwd (vitest runs with cwd = the package root).
const packageDir = process.cwd(); // packages/ui
const require = createRequire(join(packageDir, "package.json"));
const tsc = require.resolve("typescript/bin/tsc");

// Scratch files live OUTSIDE the package tree, and that is load-bearing rather
// than tidiness. `packages/actions`' repo-wide guard (tests/sync/
// protocol-facts.test.ts) lists every *.ts under packages/ and then reads each
// one, so a fixture written into packages/ui and deleted a moment later made
// that read die with ENOENT — a test in another package failing for no reason
// of its own. Only `ai-dual` runs every package on one runner in one tree, so
// it was the only job where the two could overlap, which made it a ~1-in-8
// mystery that reddened unrelated PRs. One temp dir per worker also retires the
// pid and random suffix the old names needed to stay unique in a shared dir.
const scratch = mkdtempSync(join(tmpdir(), "vendo-chrome-surface-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// The fixture imports the chrome entry from wherever it now sits.
const chromeEntry = relative(scratch, join(packageDir, "src/chrome/index.js"));
let written = 0;

// AWAITED, never sync: each tsc spawn below takes ~30s, and `execFileSync` spent
// that time blocking the vitest worker's event loop. birpc hard-codes a 60s RPC
// timeout (DEFAULT_TIMEOUT = 6e4, no config knob), so two blocking spawns in one
// worker starved the `onTaskUpdate` heartbeat past it and the whole run exited 1
// with `Timeout calling "onTaskUpdate"` while all 1370 tests passed. The
// duration is unchanged — the event loop staying free is the fix.
const execFileAsync = promisify(execFile);

/** Type-check a fixture that `import type`s `names` from the chrome entry.
 *  Returns tsc's combined output on failure, or null when it exits clean. */
async function typecheckImports(names: string[]): Promise<string | null> {
  const fixturePath = join(scratch, `surface-${written++}.ts`);
  writeFileSync(fixturePath, `import type { ${names.join(", ")} } from "${chromeEntry}";\n`);
  try {
    await execFileAsync(
      process.execPath,
      [tsc, fixturePath, "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext",
        "--moduleResolution", "Bundler", "--skipLibCheck", "--esModuleInterop", "--jsx", "react-jsx"],
      { cwd: packageDir },
    );
    return null;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
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

  it("re-exports every chrome type from the source entry", async () => {
    const failure = await typecheckImports(TYPE_EXPORTS);
    expect(failure, failure ?? "").toBeNull();
  }, 120_000);

  it("has teeth: a missing type re-export fails the tsc gate with TS2305", async () => {
    const failure = await typecheckImports(["__DefinitelyNotAChromeExport"]);
    expect(failure).not.toBeNull();
    expect(failure).toContain("TS2305");
  }, 120_000);

  // The suites that read this repo's sources treat packages/ as immutable. This
  // one writes files to do its job, so where it writes them is a contract with
  // every one of them, not a private detail.
  it("writes its scratch fixtures outside the package tree", () => {
    expect(scratch.startsWith(packageDir)).toBe(false);
  });
});
