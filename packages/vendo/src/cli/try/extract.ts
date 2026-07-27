import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  toolsFileV3Schema,
  VENDO_OVERRIDES_FORMAT_V3,
  type ExtractedToolV3,
  type ToolOverride,
} from "@vendoai/actions";
import { vendoSync } from "@vendoai/actions/sync";
import { VENDO_POLICY_FORMAT, vendoThemeSchema } from "@vendoai/core";
import { resolvePolicyConfig } from "@vendoai/guard";
import { toVendoTheme } from "../init.js";
import { readOptional, writeText } from "../shared.js";
import { extractTheme } from "../theme/extract-theme.js";

/**
 * The deterministic extraction pass behind `npx vendo try` (unified try
 * surface, Task 2): profile a host repo for the first paint with ZERO
 * commitment — no key, no network, no model, and above all no writes.
 *
 * The zero-commit contract: `repoRoot` is read-only, byte for byte. Every
 * artifact lands under `profileRoot` (a fresh `vendo-try-` temp dir when the
 * caller doesn't supply one), laid out exactly like a normal `.vendo/`
 * profile root so `assembleTryProfile(profileRoot)` (Task 1) boots from it
 * directly. A `profileRoot` inside `repoRoot` is refused outright — that
 * placement IS a write into the repo — with symlinks resolved on both sides
 * first, so a link cannot smuggle the profile back into the repo. The
 * returned `profileRoot` is caller-owned: this pass never deletes it, so a
 * temp dir it created leaks unless the caller removes it when done.
 *
 * Two existing extractors run, never reimplementations:
 *   - theme: `extractTheme` (exact-only allowlist pass), converted through
 *     init's own `toVendoTheme` → `.vendo/theme.json`
 *   - tools/catalog: `vendoSync` with `out` pointed at the profile root →
 *     `.vendo/tools.json`, `catalog.json`, ...
 *
 * Fail-soft like the assembler it feeds: either extractor throwing is
 * recorded in the summary (`status: "failed"`), never rethrown — the surface
 * must paint from whatever partial profile survived.
 */

export interface DeterministicPassOptions {
  /** The host repo to profile. Never written to. */
  repoRoot: string;
  /** Where artifacts land; a fresh temp dir is created when omitted. */
  profileRoot?: string;
}

export interface DeterministicPassResult {
  /** Caller-owned (never cleaned up here), whether supplied or freshly made. */
  profileRoot: string;
  /** slotsMatched counts exact allowlist reads plus their derived slots
   *  (contrast accentText, inherited headingFamily) — 0 = all-default theme;
   *  a carried-over host theme.json (below) reports its own top-level key
   *  count here instead — still ">0 = captured" for try.ts's summary line. */
  theme: { status: "written" | "failed"; slotsMatched: number; error?: string };
  /** A failed sync carries its error as a warning — same channel as sync's own. */
  tools: { status: "written" | "failed"; count: number; warnings: string[] };
  /** Caller-authored `.vendo/` INPUTS carried read-only from the host repo,
   *  never derived by this pass on its own: an existing artifact is the
   *  host's explicit choice and wins outright (a VALID theme.json over this
   *  pass's own extraction — a malformed one falls back to extraction rather
   *  than shipping a worse-than-absent hardcoded default, see `theme` above;
   *  brief.md/design-rules.md over the later AI deepening draft, which only
   *  drafts when absent). `policy` is the one exception with a fallback of
   *  its own — it is either carried from the host or a fresh honest demo
   *  policy is written (never left absent when the write itself succeeds): a
   *  temp profile with no policy.json makes the guard report "unconfigured"
   *  and the surface nags with the "Vendo is running without a policy"
   *  banner for every session, not just the first paint. `"absent"` is the
   *  fail-soft floor — a profileRoot too broken to write ANYTHING into (the
   *  same failure theme/tools report in their own summaries) rather than a
   *  claim this pass can't back up. */
  carriedHostInputs: {
    theme: boolean;
    brief: boolean;
    designRules: boolean;
    policy: "carried" | "demo" | "absent";
  };
}

/** The permissive policy this pass writes into the temp profile when the
 *  host repo carries none of its own: every risk auto-runs, matching the
 *  CURRENT unconfigured-guard fallthrough byte for byte (`packages/guard`'s
 *  `#pipeline` default is `{ action: "run", decidedBy: "default" }` with no
 *  policy configured at all) — this only changes the REPORTED posture from
 *  "unconfigured" to "rules" (silencing the nag banner), never what actually
 *  runs. The rules themselves are `@vendoai/guard`'s OWN "autopilot" preset,
 *  resolved through the same `resolvePolicyConfig` `createGuard` calls at
 *  compose time — never a hand-typed duplicate that could quietly drift from
 *  the real fallthrough if the preset ever changes. `directions` carries the
 *  honest comment-equivalent marker JSON has no syntax for. */
const DEMO_POLICY = {
  format: VENDO_POLICY_FORMAT,
  directions: [
    "Auto-generated by `npx vendo try` — no .vendo/policy.json existed on this "
      + "host, and every action here runs against synthetic fixture data anyway, "
      + "so this demo policy runs everything without asking.",
  ],
  rules: resolvePolicyConfig("autopilot")!.rules!,
};

/**
 * genqa defect 1 (venue self-strangulation): `extractedRisk` (packages/actions
 * sync/common.ts) fail-closes every route-scanned GET to `write` — a route
 * scan can't prove a real host's handler is side-effect-free, so core is
 * right to be cautious there. But `npx vendo try` never talks to a real
 * host: every tool call runs against the synthetic fixtures THIS
 * deterministic pass just wrote, so a route GET's honesty is no longer in
 * question the way it is for production traffic. Left uncorrected, the
 * demo policy's read-auto-run rules never match these tools, and the
 * guard's per-session write budget (packages/guard maxWritesPerRun) parks
 * every one of them alongside real writes — a demo run dies after ~10 calls
 * regardless of how many were genuine mutations.
 *
 * Fixed at THIS seam, never common.ts: an override is a correction, not a
 * reclassification of the extractor's own fail-closed default, and it rides
 * the SAME `.vendo/overrides.json` mechanism doctor/the running server
 * already treat as authoritative over tools.json (mergeOverride,
 * packages/actions runtime/registry.ts). Scoped tight — only
 * `binding.kind === "route"` GETs the extractor left at `write`; a
 * `destructive` GET (a delete-shaped name) is a real signal and stays as is.
 */
async function writeTryReadDowngrades(vendoDir: string, tools: readonly ExtractedToolV3[]): Promise<void> {
  const corrections: Record<string, ToolOverride> = {};
  for (const tool of tools) {
    if (tool.binding.kind === "route" && tool.binding.method === "GET" && tool.risk === "write") {
      corrections[tool.name] = { risk: "read" };
    }
  }
  if (Object.keys(corrections).length === 0) return;
  await writeText(
    join(vendoDir, "overrides.json"),
    `${JSON.stringify({ format: VENDO_OVERRIDES_FORMAT_V3, tools: corrections }, null, 2)}\n`,
  );
}

/** Resolve symlinks through the nearest EXISTING ancestor, re-joining any
 *  not-yet-created tail; falls back to the lexical path when nothing on the
 *  way exists (the relative() guard then judges the lexical spelling). */
async function realpathToward(path: string): Promise<string> {
  let existing = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(await realpath(existing), ...tail);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return path;
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** Run the deterministic extractors against `repoRoot`, writing a paintable
 *  profile under `profileRoot`. Resolves (never rejects) for any readable
 *  repo; only the zero-commit placement guard throws. */
export async function runDeterministicPass(
  options: DeterministicPassOptions,
): Promise<DeterministicPassResult> {
  const repoRoot = resolve(options.repoRoot);
  const profileRoot = options.profileRoot === undefined
    ? await mkdtemp(join(tmpdir(), "vendo-try-"))
    : resolve(options.profileRoot);
  const placement = relative(await realpathToward(repoRoot), await realpathToward(profileRoot));
  if (placement === "" || (!placement.startsWith("..") && !isAbsolute(placement))) {
    throw new Error(`profileRoot ${profileRoot} is inside repoRoot ${repoRoot} — the try pass never writes into the repo`);
  }
  const vendoDir = join(profileRoot, ".vendo");
  const hostVendoDir = join(repoRoot, ".vendo");

  // Carry over caller-authored `.vendo/` INPUTS before anything else derives
  // its own defaults — read-only reads off repoRoot, writes only under
  // profileRoot (the zero-commit contract above holds: repoRoot never sees a
  // byte). theme.json below checks `hostTheme` FIRST and skips extraction
  // entirely when it's present, so the host's explicit theme always wins.
  const hostTheme = await readOptional(join(hostVendoDir, "theme.json"));
  const hostBrief = await readOptional(join(hostVendoDir, "brief.md"));
  const hostDesignRules = await readOptional(join(hostVendoDir, "design-rules.md"));
  const hostPolicy = await readOptional(join(hostVendoDir, "policy.json"));

  // Fail-soft like every other artifact in this pass (theme/tools below): a
  // profileRoot that can't be written to degrades this carry-over quietly
  // instead of throwing — the surface still paints from whatever landed.
  // Each outcome is tracked from the exact write it names — never inferred
  // from input presence alone, which would misreport a write that failed.
  let briefCarried = false;
  let designRulesCarried = false;
  let policyOutcome: DeterministicPassResult["carriedHostInputs"]["policy"] = "absent";
  try {
    if (hostBrief !== null) {
      await writeText(join(vendoDir, "brief.md"), hostBrief);
      briefCarried = true;
    }
    if (hostDesignRules !== null) {
      await writeText(join(vendoDir, "design-rules.md"), hostDesignRules);
      designRulesCarried = true;
    }
    await writeText(
      join(vendoDir, "policy.json"),
      hostPolicy ?? `${JSON.stringify(DEMO_POLICY, null, 2)}\n`,
    );
    policyOutcome = hostPolicy !== null ? "carried" : "demo";
  } catch {
    // Degraded profileRoot: the theme/tools passes below hit the identical
    // failure and report it in their own summaries; this carry-over just
    // leaves its artifacts absent rather than throwing a second time.
  }

  // A malformed host theme.json falls back to extraction rather than
  // shipping assembleTryProfile's hardcoded default — present-but-corrupt
  // must never paint worse than the host having no theme.json at all. The
  // parse failure still rides the summary (`theme.error`) even though the
  // overall status recovers to "written" via the fallback.
  let hostThemeError: string | undefined;
  let hostThemeParsed: ReturnType<typeof vendoThemeSchema.parse> | undefined;
  if (hostTheme !== null) {
    try {
      hostThemeParsed = vendoThemeSchema.parse(JSON.parse(hostTheme));
    } catch (error) {
      hostThemeError = String(error);
    }
  }
  let theme: DeterministicPassResult["theme"];
  const themeCarried = hostThemeParsed !== undefined;
  if (hostThemeParsed !== undefined) {
    await writeText(join(vendoDir, "theme.json"), `${JSON.stringify(hostThemeParsed, null, 2)}\n`);
    theme = { status: "written", slotsMatched: Object.keys(hostThemeParsed).length };
  } else {
    try {
      const summary = await extractTheme(repoRoot);
      await writeText(join(vendoDir, "theme.json"), `${JSON.stringify(toVendoTheme(summary.slots), null, 2)}\n`);
      theme = {
        status: "written",
        slotsMatched: Object.keys(summary.matched).length,
        ...(hostThemeError === undefined ? {} : { error: hostThemeError }),
      };
    } catch (error) {
      // Extraction itself failed too: the host's own parse error (when there
      // was one) is the more actionable of the two — it names a real file the
      // host repo carries, where the extractor's failure is often just "no
      // matching CSS tokens".
      theme = { status: "failed", slotsMatched: 0, error: hostThemeError ?? String(error) };
    }
  }

  let tools: DeterministicPassResult["tools"];
  try {
    const report = await vendoSync({ root: repoRoot, out: vendoDir });
    // vendoSync writes the v3 format (post-#568); parse what it just wrote.
    const written = toolsFileV3Schema.parse(JSON.parse(await readFile(join(vendoDir, "tools.json"), "utf8")));
    tools = { status: "written", count: written.tools.length, warnings: report.warnings };
    // Try-venue-only downgrade (genqa defect 1): every call here executes
    // against fixtures THIS pass just extracted, never a real host, so write
    // it as a normal overrides.json correction — never touch common.ts's
    // fail-closed extractedRisk default, which stays exactly as cautious for
    // every OTHER caller (init/sync against a real host).
    await writeTryReadDowngrades(vendoDir, written.tools);
  } catch (error) {
    tools = { status: "failed", count: 0, warnings: [String(error)] };
  }

  return {
    profileRoot,
    theme,
    tools,
    carriedHostInputs: {
      theme: themeCarried,
      brief: briefCarried,
      designRules: designRulesCarried,
      policy: policyOutcome,
    },
  };
}
