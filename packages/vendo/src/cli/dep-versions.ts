import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostFramework } from "./framework.js";

/**
 * Bare dependency versions for telemetry (posthog-analytics design §3):
 * version strings are non-identifying, in line with what Astro/Nx collect
 * anonymously. Missing dependencies are omitted, never sent as placeholders.
 */
export interface DepVersions {
  frameworkVersion?: string;
  reactVersion?: string;
  zodVersion?: string;
  typescriptVersion?: string;
}

/** The npm package that IS each detected framework (detectFramework's own
    evidence source, framework.ts). */
const FRAMEWORK_PACKAGE: Record<Exclude<HostFramework, "unknown">, string> = {
  next: "next",
  express: "express",
};

/**
 * Normalize a semver range to its bare version: "^15.3.1" → "15.3.1",
 * "~4.2" → "4.2", ">=3.0.0-beta.1" → "3.0.0-beta.1", "workspace:^0.3.0" →
 * "0.3.0". Ranges carrying no version at all ("*", "latest") → undefined.
 */
function bareVersion(range: unknown): string | undefined {
  if (typeof range !== "string") return undefined;
  return range.match(/\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
}

/**
 * Read the host project's dependency versions (deps + devDeps) for telemetry.
 * Non-throwing: a missing or malformed package.json returns {}.
 */
export async function detectDepVersions(root: string, framework: HostFramework): Promise<DepVersions> {
  try {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const dependencies = { ...manifest.devDependencies, ...manifest.dependencies };
    const out: DepVersions = {};
    const frameworkPackage = framework === "unknown" ? undefined : FRAMEWORK_PACKAGE[framework];
    const frameworkVersion = frameworkPackage === undefined ? undefined : bareVersion(dependencies[frameworkPackage]);
    if (frameworkVersion !== undefined) out.frameworkVersion = frameworkVersion;
    const reactVersion = bareVersion(dependencies["react"]);
    if (reactVersion !== undefined) out.reactVersion = reactVersion;
    const zodVersion = bareVersion(dependencies["zod"]);
    if (zodVersion !== undefined) out.zodVersion = zodVersion;
    const typescriptVersion = bareVersion(dependencies["typescript"]);
    if (typescriptVersion !== undefined) out.typescriptVersion = typescriptVersion;
    return out;
  } catch {
    return {};
  }
}
