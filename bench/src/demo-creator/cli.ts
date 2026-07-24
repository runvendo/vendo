#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { displayAppPath, parseDemoCreateArgs, runDemoCreate, type DemoCreateResult } from "./create.js";
import { parseDemoDeployArgs, runDemoDeploy } from "./deploy.js";
import { parseDemoReapArgs, runDemoReap } from "./reap.js";
import { parseDemoResearchArgs, runDemoResearch } from "./research.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function usage(): string {
  return `Usage:
  pnpm --filter @vendoai/bench demo:create -- --id SLUG --prospect NAME [--cta-url URL] [--target-dir DIR] [--url PROSPECT_SITE]
  pnpm --filter @vendoai/bench demo:research -- --app APP_DIR --url https://... [--url https://...]
  pnpm --filter @vendoai/bench demo:deploy -- --app apps/demo-SLUG [--project NAME] [--router-url URL] [--skip-registry] [--dry-run]
  pnpm --filter @vendoai/bench demo:reap -- [--router-url URL] [--project NAME] [--execute]

demo:create clones apps/demo-template into <target-dir>/demo-<id> (default apps/)
and writes a TODO-fenced demo.config.json skeleton plus a RESEARCH/ pointer.
demo:research captures each prospect URL's brand evidence (screenshots, title,
theme-color, favicon, computed-style palette) into <APP_DIR>/RESEARCH/.
demo:deploy ships one demo app to Railway (project vendo-demos by default) and
registers it with the demos.vendo.run router; needs ANTHROPIC_API_KEY and
ROUTER_ADMIN_TOKEN in the environment (neither is ever logged).
demo:reap lists registry rows past expiry or killed and (with --execute) removes
their Railway deployments + registry rows; dry-run by default.`;
}

function createEpilogue(result: DemoCreateResult, prospectUrl: string | undefined): string {
  const appPath = displayAppPath(repoRoot, result.appDir);
  return `Created ${appPath} (package ${result.packageName}) from apps/demo-template.

Next steps:
  1. pnpm install    # link the new workspace app
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
  if (command === "deploy") {
    const args = parseDemoDeployArgs(rest);
    const result = await runDemoDeploy(args, { repoRoot });
    if (!result.dryRun && result.registryPayload !== undefined) {
      process.stdout.write(`\nLive at ${args.routerUrl.replace(/\/+$/, "")}/${result.registryPayload.id}\n`);
    }
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
