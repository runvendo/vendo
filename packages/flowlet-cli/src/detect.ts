import { promises as fs } from "node:fs";
import path from "node:path";
import { walk } from "./fsx.js";

export interface FrameworkInfo {
  framework: "next" | "vite" | "remix" | "unknown";
  tailwind: "v4-css" | "v3-config" | "none";
  cssFiles: string[];
  tailwindConfigPath: string | null;
  openapiPath: string | null;
}

const OPENAPI_CANDIDATES = [
  "openapi.json", "openapi.yaml", "openapi.yml",
  "swagger.json", "swagger.yaml",
  "docs/openapi.json", "docs/openapi.yaml", "public/openapi.json", "api/openapi.json",
];
const TW_CONFIGS = ["tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs", "tailwind.config.ts"];

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

export async function detectTarget(targetDir: string): Promise<FrameworkInfo> {
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(targetDir, "package.json"), "utf8"));
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    // no/invalid package.json — everything stays "unknown"
  }

  const framework: FrameworkInfo["framework"] =
    deps["next"] ? "next"
    : deps["@remix-run/react"] ? "remix"
    : deps["vite"] ? "vite"
    : "unknown";

  const cssFiles = await walk(targetDir, (p) => p.endsWith(".css"), 500);

  let tailwindConfigPath: string | null = null;
  for (const c of TW_CONFIGS) {
    if (await exists(path.join(targetDir, c))) { tailwindConfigPath = path.join(targetDir, c); break; }
  }

  let tailwind: FrameworkInfo["tailwind"] = "none";
  if (tailwindConfigPath) tailwind = "v3-config";
  else if (deps["tailwindcss"]) tailwind = "v4-css"; // dep present, no config file — CSS-first

  let openapiPath: string | null = null;
  for (const c of OPENAPI_CANDIDATES) {
    if (await exists(path.join(targetDir, c))) { openapiPath = path.join(targetDir, c); break; }
  }

  return { framework, tailwind, cssFiles, tailwindConfigPath, openapiPath };
}
