#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDemoChipsArgs, runDeriveChips } from "./chips.js";
import { displayAppPath, parseDemoCreateArgs, runDemoCreate, type DemoCreateResult } from "./create.js";
import { parseDemoDeployArgs, runDemoDeploy } from "./deploy.js";
import { parseDemoPipelineArgs, runDemoPipeline } from "./pipeline.js";
import { parseDemoReapArgs, runDemoReap } from "./reap.js";
import { parseDemoResearchArgs, runDemoResearch } from "./research.js";
import { defaultDemoScratchDir } from "./scratch.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function usage(): string {
  return `Usage:
  pnpm --filter @vendoai/bench demo:create -- --id SLUG --prospect NAME [--cta-url URL] [--target-dir DIR] [--url PROSPECT_SITE] [--screenshots a.png,b.png] [--notes notes.md]
  pnpm --filter @vendoai/bench demo:research -- --app APP_DIR --url https://... [--url https://...]
  pnpm --filter @vendoai/bench demo:chips -- --app APP_DIR [--prospect NAME]
  pnpm --filter @vendoai/bench demo:deploy -- --app apps/demo-SLUG [--project NAME] [--router-url URL] [--skip-registry] [--dry-run]
  pnpm --filter @vendoai/bench demo:reap -- [--router-url URL] [--project NAME] [--execute]
  pnpm --filter @vendoai/bench demo:pipeline -- --id SLUG --prospect NAME --url PROSPECT_SITE [--screenshots a.png,b.png] [--notes notes.md] [--cta-url URL] [--target-dir DIR] [--port N] [--skip-capture] [--skip-deploy]

demo:create clones apps/demo-template into <target-dir>/demo-<id> and writes a
TODO-fenced demo.config.json skeleton plus a RESEARCH/ pointer. The default
target is a scratch dir OUTSIDE this repo (${defaultDemoScratchDir()}) — a
generated demo is a prospect's brand and must never be committable here; such a
clone is made self-contained by vendoring this tree's @vendoai/* packages into
its vendor/ dir. --target-dir apps keeps it in the workspace for local poking
(gitignored).
--screenshots copies operator-provided product screenshots into RESEARCH/ as
top-priority brand evidence (indexed with provenance in RESEARCH/manifest.json).
--notes copies a markdown file of operator instructions into
RESEARCH/OPERATOR-NOTES.md; the rewrite inlines it into the brand brief and
every agent prompt as AUTHORITATIVE — the way to pin a fact the operator has
already established (the persona the product's own screens show, the currency,
a page title) against the rewrite's invent-everything default.
demo:research captures each prospect URL's brand evidence (screenshots, title,
theme-color, favicon, computed-style palette) into <APP_DIR>/RESEARCH/.
demo:chips rewrites the demo's example pills from its OWN extracted tool surface
(<APP_DIR>/.vendo/tools.json) so they name the prospect's real capabilities;
hand-authored beats are kept verbatim and derived ones fill the rest. Runs
inside demo:pipeline after the rewrite; standalone for re-deriving.
demo:deploy ships one demo app to Railway (project vendo-demos by default) and
registers it with the demos.vendo.run router. An in-repo app deploys the
monorepo; a scratch clone deploys itself. Needs ROUTER_ADMIN_TOKEN plus an
inference key — VENDO_API_KEY for the Cloud posture (hosted store, connections
broker, metered gateway) or ANTHROPIC_API_KEY for BYO. None is ever logged.
demo:reap lists registry rows past expiry or killed and (with --execute) removes
their Railway deployments + registry rows; dry-run by default.`;
}

function createEpilogue(result: DemoCreateResult, prospectUrl: string | undefined): string {
  const appPath = displayAppPath(repoRoot, result.appDir);
  return `Created ${appPath} (package ${result.packageName}) from apps/demo-template.
${result.standalone
    ? "Standalone clone: outside the repo, with this tree's @vendoai/* vendored into vendor/."
    : "In-repo clone: a workspace member (gitignored — never commit it)."}

Next steps:
  1. ${result.standalone ? `cd ${appPath} && pnpm install    # install the clone's own deps` : "pnpm install    # link the new workspace app"}
  2. Research the prospect's brand:
       pnpm --filter @vendoai/bench demo:research -- --app ${appPath} --url ${prospectUrl ?? "<prospect site>"}
  3. Follow ~/.claude/skills/demo-creator/PLAYBOOK.md with ${appPath}/VERIFY.md — replace every "TODO(creator): " placeholder.
  4. Verify the finished demo:
       pnpm --filter @vendoai/bench demo:capture -- demo-beats --host-config ${appPath}`;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  // The command positional comes from the package.json script itself
  // (demo:create / demo:research); everything after it is user arguments.
  const [command, ...rest] = process.argv.slice(2);
  if (command === "create") {
    const args = parseDemoCreateArgs(rest);
    const result = await runDemoCreate(args, { repoRoot });
    process.stdout.write(`${createEpilogue(result, args.url)}\n`);
    return;
  }
  if (command === "research") {
    const args = parseDemoResearchArgs(rest);
    const result = await runDemoResearch(args, { repoRoot });
    process.stdout.write(`${JSON.stringify({
      researchDir: result.researchDir,
      reportPath: result.reportPath,
      pages: result.report.pages.map((page) => ("error" in page
        ? { url: page.url, error: page.error }
        : {
          url: page.url,
          title: page.title,
          botChallenge: page.botChallenge,
          assetsSaved: page.assets.filter((asset) => asset.file !== null).length,
          assetsSkipped: page.assets.filter((asset) => asset.file === null).length,
        })),
      palette: result.report.palette,
      fonts: result.report.fonts,
    }, null, 2)}\n`);
    return;
  }
  if (command === "chips") {
    const args = parseDemoChipsArgs(rest);
    const result = await runDeriveChips(
      { appDir: path.resolve(repoRoot, args.app), ...(args.prospect === undefined ? {} : { prospect: args.prospect }) },
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "deploy") {
    const args = parseDemoDeployArgs(rest);
    const result = await runDemoDeploy(args, { repoRoot });
    if (!result.dryRun && result.registryPayload !== undefined) {
      process.stdout.write(`\nLive at ${args.routerUrl.replace(/\/+$/, "")}/${result.registryPayload.id}\n`);
    }
    return;
  }
  if (command === "pipeline") {
    const args = parseDemoPipelineArgs(rest);
    const result = await runDemoPipeline(args, { repoRoot });
    const lines = [
      `Pipeline finished for ${result.appPath}`,
      ...(result.demoUrl === undefined ? [] : [`Live at ${result.demoUrl} (gate: ${result.gate?.steps.every((step) => step.ok) === true ? "PASS" : "see report"})`]),
      ...(result.gifPath === undefined ? [] : [`GIF: ${result.gifPath}`]),
      `Fidelity report: ${result.judge.reportPath}`,
      `Timings: ${result.appPath}/timings.json`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  if (command === "reap") {
    const result = await runDemoReap(parseDemoReapArgs(rest), {});
    // Failed teardowns kept their registry rows — surface that to callers
    // (the mini's reap routine alerts on nonzero exit).
    if (result.failed.length > 0) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown demo-creator command: ${command ?? "(missing)"}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
});
