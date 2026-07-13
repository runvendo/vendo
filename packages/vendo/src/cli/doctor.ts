import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Telemetry } from "@vendoai/telemetry";
import { detectFramework, detectVendoWiring } from "./framework.js";
import { consoleOutput, exists, toolingTelemetry, type Output } from "./shared.js";

export interface DoctorOptions {
  targetDir: string;
  url?: string;
  fetchImpl?: typeof fetch;
  output?: Output;
  telemetry?: {
    home?: string;
    env?: Record<string, string | undefined>;
    posthogKey?: string;
    fetchImpl?: typeof fetch;
  };
}

async function hasDependency(root: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return [manifest.dependencies, manifest.devDependencies].some((deps) =>
      deps?.["@vendoai/vendo"] !== undefined || deps?.vendoai !== undefined);
  } catch {
    return false;
  }
}

function telemetryFor(options: DoctorOptions, output: Output): Telemetry {
  return toolingTelemetry({ ...options.telemetry, log: (message) => output.log(message) });
}

/** 09-vendo §5 — read-only wiring checks plus one real /status probe. */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  const root = resolve(options.targetDir);
  const output = options.output ?? consoleOutput;
  const telemetry = telemetryFor(options, output);
  let failures = 0;
  let warnings = 0;
  const pass = (message: string): void => output.log(`ok: ${message}`);
  const fail = (message: string): void => { failures += 1; output.error(`broken: ${message}`); };
  const warn = (message: string): void => { warnings += 1; output.error(`warning: ${message}`); };

  const framework = await detectFramework(root);
  if (framework === "express") {
    const wiring = await detectVendoWiring(root);
    if (wiring.server) pass("Express server is wired");
    else fail("Express server is not wired with createVendo from @vendoai/vendo/server");
    if (wiring.client) pass("<VendoRoot> wraps the client");
    else fail("Express client is not wrapped in <VendoRoot>");
  } else {
    const routeCandidates = [
      join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
      join(root, "src", "app", "api", "vendo", "[...vendo]", "route.ts"),
    ];
    if ((await Promise.all(routeCandidates.map(exists))).some(Boolean)) pass("catch-all handler is wired");
    else fail("missing app/api/vendo/[...vendo]/route.ts");

    const layoutCandidates = [join(root, "app", "layout.tsx"), join(root, "src", "app", "layout.tsx")];
    let rootWired = false;
    for (const path of layoutCandidates) {
      try {
        if ((await readFile(path, "utf8")).includes("<VendoRoot")) rootWired = true;
      } catch {
        // Try the other layout convention.
      }
    }
    if (rootWired) pass("<VendoRoot> wraps the app");
    else fail("root layout is not wrapped in <VendoRoot>");
  }

  if (await hasDependency(root)) pass("@vendoai/vendo dependency is declared");
  else fail("@vendoai/vendo (or vendoai alias) is not declared");

  for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) {
    if (await exists(join(root, ".vendo", file))) pass(`.vendo/${file}`);
    else fail(`missing .vendo/${file}`);
  }
  if (!await exists(join(root, ".vendo", "data", ".gitignore"))) warn(".vendo/data/.gitignore is missing");

  const statusUrl = options.url
    ?? process.env.VENDO_URL?.replace(/\/$/, "")
    ?? "http://localhost:3000/api/vendo";
  try {
    const response = await (options.fetchImpl ?? fetch)(`${statusUrl}/status`, {
      headers: { accept: "application/json" },
    });
    const body = await response.json() as { posture?: unknown; version?: unknown; blocks?: unknown };
    if (!response.ok || typeof body.posture !== "string" || typeof body.version !== "string"
      || typeof body.blocks !== "object" || body.blocks === null) {
      fail(`/status returned an invalid composition response (${response.status})`);
    } else {
      pass(`/status live round-trip (${body.version}, ${body.posture})`);
    }
  } catch {
    fail(`/status is unreachable at ${statusUrl}/status`);
  }

  output.log("Ladder: add sandbox to unlock server apps; actAs for away host actions; connectors for external tools.");
  const wired = failures === 0;
  await telemetry.track("doctor_run", { failures, warnings, wired });
  return wired ? 0 : 1;
}
