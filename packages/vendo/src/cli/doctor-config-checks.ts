import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { applyJudgment, judgmentsFileSchema, overridesFileSchema, toolsFileSchema, type ExtractedTool, type ToolJudgment, type ToolsFile } from "@vendoai/actions";
import { firstOpenApiSpec, openApiMountPath } from "@vendoai/actions/sync";
import { publicBase, type RiskLabel } from "@vendoai/core";
import { CONFIG_SURFACES, OVERRIDES_ENABLEMENT_NOTE } from "../config-surface.js";
import { describeDevCredential, resolveDevCredential } from "../dev-creds/resolve.js";
// Relative (not the #dev-creds condition): the CLI is Node-only and the edge
// build deliberately does not export the pin map.
import { SLOT_PIN_ENV } from "../dev-creds/model.js";
import type { DoctorRun } from "./doctor-report.js";
import { EJECT_MANIFEST_FILE, type EjectedManifest } from "./eject.js";
import { walk } from "./theme/walk.js";
import { exists, readOptional } from "./shared.js";

export async function checkConfigFiles(run: DoctorRun): Promise<void> {
  const { root } = run;
  for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) {
    if (await exists(join(root, ".vendo", file))) run.pass(`config/${file}`, `.vendo/${file}`);
    else run.fail(`config/${file}`, "E-CFG-001", `missing .vendo/${file}`);
  }
  if (!await exists(join(root, ".vendo", "data", ".gitignore"))) run.warn("config/data-gitignore", "E-CFG-002", ".vendo/data/.gitignore is missing");
}

/** Spec 2026-08-06 §B1 — the deployment's path prefix has exactly one home:
 *  VENDO_BASE_URL. A spec that declares a DIFFERENT relative server mount is the
 *  #914 shape by another route: every page renders and every tool call 404s. */
export async function checkMountAgreement(run: DoctorRun): Promise<void> {
  const { root, env } = run;
  const specPath = await firstOpenApiSpec(root);
  const declaredMount = specPath === null ? "" : await openApiMountPath(specPath);
  const configuredBase = env["VENDO_BASE_URL"];
  if (declaredMount === "" || configuredBase === undefined || configuredBase.trim() === "") return;
  let basePath = "";
  try {
    basePath = publicBase(configuredBase).path;
  } catch {
    basePath = "";
  }
  if (basePath !== declaredMount) {
    run.fail("config/mount", "E-CFG-003",
      `${relative(root, specPath!)} declares servers[0].url ${JSON.stringify(declaredMount)} but VENDO_BASE_URL's path is `
      + `${JSON.stringify(basePath)} — one of them is wrong, and the disagreement 404s every host tool while every page renders. `
      + `Set VENDO_BASE_URL to the app's FULL public URL including ${JSON.stringify(declaredMount)}, or drop the relative server from the spec.`);
  } else {
    run.pass("config/mount", `the OpenAPI server mount and VENDO_BASE_URL agree on ${JSON.stringify(declaredMount)}`);
  }
}

/** cse lane 3 — per-surface OWNERSHIP: for each cloud-resolvable content
 *  surface, is the local file the source of truth, or is it resolved at
 *  runtime (from hosted config when VENDO_API_KEY is set, else unset)? Local
 *  only (no console call) — `vendo config status` does the cloud-aware view.
 *  A programmatic `explicit` override in createVendo is not observable here. */
export async function checkSurfaceOwnership(run: DoctorRun): Promise<void> {
  const surfaceOwners = await Promise.all(
    CONFIG_SURFACES.map(async (surface) => `${surface}=${(await exists(join(run.root, ".vendo", surface))) ? "file" : "runtime"}`),
  );
  run.pass("config/ownership", `surface ownership (file = local source of truth; runtime = resolved from hosted config or unset): ${surfaceOwners.join(", ")}. ${OVERRIDES_ENABLEMENT_NOTE}`);
}

/** Models spec 2026-07-22 — exactly two honest model facts, resolver-based
 *  (the same resolver the runtime rides, no network): which credential rung
 *  wins, and any active VENDO_MODEL_* pins. Deliberately NO role/alias
 *  table: on the Cloud rung the family names map to concrete models
 *  SERVER-SIDE, so the client would only be guessing. */
export async function checkModelResolution(run: DoctorRun): Promise<void> {
  const { env } = run;
  const modelCredential = await resolveDevCredential({ env });
  if (modelCredential.rung !== "none") {
    run.pass("model/credential", `model credential: ${describeDevCredential(modelCredential)}`);
  } else {
    run.note("model credential: none found — the live turn check below carries the honest failure");
  }
  const activePins = Object.values(SLOT_PIN_ENV)
    .map((name) => ({ name, value: env[name]?.trim() }))
    .filter((pin): pin is { name: string; value: string } => (pin.value ?? "").length > 0);
  if (activePins.length > 0) {
    run.pass("model/pins", `model pins: ${activePins.map(({ name, value }) => `${name}=${value}`).join(", ")}`);
  }
}

/** The three-layer effective stack the runtime resolves: skeleton ⊕ judgments ⊕
 *  overrides. `applyJudgment` ignores an entry whose binding moved and applies
 *  the fail-closed audience exclusion, so a disable a check reports is one the
 *  agent will actually see. A human override still wins last — including a
 *  deliberate wake of something a judgment disabled. */
function effectiveGrades(
  toolsFile: ToolsFile,
  judgments: Record<string, ToolJudgment>,
  overridesTools: Record<string, { disabled?: boolean; risk?: RiskLabel }>,
): { live: number; ungraded: number } {
  const live = toolsFile.tools.filter((tool) => {
    const effective = applyJudgment(tool, judgments[tool.name]);
    return (overridesTools[tool.name]?.disabled ?? effective.disabled ?? false) !== true;
  });
  // Risk-grading redesign D4 — not-knowing must be FELT. Extraction only
  // asserts protocol facts, so a catalog nobody has judged is mostly
  // `ungraded`, and every ungraded tool asks on each call. Counted over the
  // same three-layer effective stack, so a judged or overridden grade is
  // reflected here exactly as the guard will see it.
  const ungraded = toolsFile.tools.filter((tool) => {
    const effective = applyJudgment(tool, judgments[tool.name]);
    return (overridesTools[tool.name]?.risk ?? effective.risk) === "ungraded";
  });
  return { live: live.length, ungraded: ungraded.length };
}

/** Malformed overrides are their own (pre-existing) failure surface, and
 *  malformed judgments are the judgment pass's own loud failure; the grade
 *  reads the skeleton rather than guessing at either file. */
function parseSidecar<T>(raw: string | null, parse: (value: unknown) => T, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return parse(JSON.parse(raw) as unknown);
  } catch {
    return fallback;
  }
}

/** Not-knowing must be FELT here too. A blind slot is not a failure — the
 *  tool still works permissively — but it is why an agent pastes a whole
 *  response into a card instead of binding two fields, and why it calls a
 *  tool with no arguments when the handler wanted three. */
function checkSchemaCoverage(run: DoctorRun, tools: ExtractedTool[]): void {
  const blindInputs = tools
    .filter((tool) => (tool.inputSchemaSource ?? "unknown") === "unknown")
    .map((tool) => tool.name);
  const blindOutputs = tools
    .filter((tool) => (tool.outputSchemaSource ?? "unknown") === "unknown")
    .map((tool) => tool.name);
  const total = tools.length;
  const coverage = `inputs ${total - blindInputs.length}/${total} · outputs ${total - blindOutputs.length}/${total}`;
  if (blindInputs.length > 0 || blindOutputs.length > 0) {
    const blind = [...new Set([...blindInputs, ...blindOutputs])].sort();
    run.warn(
      "tools/schemas",
      "E-TOOLS-004",
      `catalog: ${coverage} — blind: ${blind.slice(0, 8).join(", ")}${blind.length > 8 ? ` +${blind.length - 8} more` : ""};`
      + " declare them in your OpenAPI/tRPC contract, or run `vendo sync` with a model key so the judge reads the handlers",
    );
  } else if (total > 0) {
    run.pass("tools/schemas", `catalog: ${coverage}`);
  }
}

/** The core promise, statically checkable: does the agent have any HOST
 *  tool it may actually call? All-disabled is an explicit misconfiguration
 *  (fail); an empty extraction is a strong warning — connector-only hosts
 *  are legitimate, but a fresh install landing here means extraction found
 *  nothing user-facing (field case: an infra product whose surface was all
 *  internal endpoints ended with tools: [] and a silently useless agent). */
export async function checkToolCatalog(run: DoctorRun): Promise<void> {
  const { root } = run;
  const toolsRaw = await readOptional(join(root, ".vendo", "tools.json"));
  const overridesRaw = await readOptional(join(root, ".vendo", "overrides.json"));
  const judgmentsRaw = await readOptional(join(root, ".vendo", "judgments.json"));
  if (toolsRaw === null) return;
  try {
    const toolsParsed: unknown = JSON.parse(toolsRaw);
    const toolsFile = toolsFileSchema.parse(toolsParsed);
    const overridesTools = parseSidecar<Record<string, { disabled?: boolean; risk?: RiskLabel }>>(
      overridesRaw, (value) => overridesFileSchema.parse(value).tools, {});
    const judgments = parseSidecar<Record<string, ToolJudgment>>(
      judgmentsRaw, (value) => judgmentsFileSchema.parse(value).tools, {});
    const { live, ungraded } = effectiveGrades(toolsFile, judgments, overridesTools);
    if (toolsFile.tools.length === 0) {
      run.warn("tools/live-surface", "E-TOOLS-002", "the extracted tool surface is empty — the agent cannot act on this product's API; re-run `vendo init` extraction (or ignore if this deployment is connector-only)");
    } else if (live === 0) {
      run.fail("tools/live-surface", "E-TOOLS-001", `zero live host tools — all ${toolsFile.tools.length} extracted tools are disabled or excluded; review the audience exclusions in .vendo/overrides.json and re-enable the end-user surface (disabled: false)`);
    } else {
      run.pass("tools/live-surface", `${live} live host tool${live === 1 ? "" : "s"}`);
    }
    if (ungraded > 0) {
      run.warn("tools/graded", "E-TOOLS-003", `catalog: ${ungraded}/${toolsFile.tools.length} tools ungraded — each one asks on every call; run \`vendo sync\` with a model key to grade`);
    } else {
      run.pass("tools/graded", `catalog: all ${toolsFile.tools.length} tools graded`);
    }
    checkSchemaCoverage(run, toolsFile.tools);
  } catch {
    // Not a vendo/tools@3 shape (e.g. a placeholder {}) — the config
    // checks above already govern presence; nothing to grade here.
  }
}

/** §4 customization ladder — ejected chrome drift. The ejected pixels are the
 *  host's code, so a version gap is awareness (warn), never breakage (fail):
 *  the hooks/wire dependency keeps working; only new presentation is missed. */
export async function checkEjectDrift(run: DoctorRun): Promise<void> {
  const { root } = run;
  const installedUi = await readOptional(join(root, "node_modules", "@vendoai", "ui", "package.json"));
  let uiVersion: string | null = null;
  try {
    if (installedUi !== null) uiVersion = (JSON.parse(installedUi) as { version?: string }).version ?? null;
  } catch {
    // Malformed install metadata — skip the drift check rather than fail doctor.
  }
  if (uiVersion === null) return;
  for (const manifestPath of await walk(root, (rel) => rel.endsWith(EJECT_MANIFEST_FILE))) {
    let ejected: EjectedManifest;
    try {
      ejected = JSON.parse(await readFile(manifestPath, "utf8")) as EjectedManifest;
    } catch {
      continue;
    }
    if (ejected.version === uiVersion) {
      run.pass(`eject/${ejected.surface}`, `ejected ${ejected.surface} matches @vendoai/ui v${uiVersion}`);
    } else {
      run.warn(`eject/${ejected.surface}`, "E-UI-001", `ejected ${ejected.surface} came from @vendoai/ui v${ejected.version} but v${uiVersion} is installed — review the changelog (https://github.com/runvendo/vendo/releases) and \`vendo eject ${ejected.surface} --force\` if you want the new presentation`);
    }
  }
}
