import { describe, expect, it } from "vitest";
import { normalizeBootstrapInstallCommand, normalizePostInjectionInstallCommand } from "./install-command.js";

// Package-manager forms actually present in corpus/manifest.json: plain pnpm,
// corepack pnpm, npm ci, corepack yarn (with and without an env-var prefix).

describe("normalizeBootstrapInstallCommand", () => {
  it("adds the pnpm-11 config flags to a plain pnpm install and still strips frozen-lockfile flags", () => {
    const result = normalizeBootstrapInstallCommand("pnpm install --frozen-lockfile --force --ignore-workspace");

    expect(result).toEqual({
      command:
        "pnpm --config.minimumReleaseAge=0 --config.dangerouslyAllowAllBuilds=true install --no-frozen-lockfile --force --ignore-workspace",
      changed: true,
    });
  });

  it("adds the pnpm-11 config flags to a corepack pnpm install", () => {
    const result = normalizeBootstrapInstallCommand("corepack pnpm install --frozen-lockfile --force --ignore-workspace");

    expect(result).toEqual({
      command:
        "corepack pnpm --config.minimumReleaseAge=0 --config.dangerouslyAllowAllBuilds=true install --no-frozen-lockfile --force --ignore-workspace",
      changed: true,
    });
  });

  it("drops --ignore-workspace alongside the config flags when the repo has a pnpm workspace", () => {
    const result = normalizeBootstrapInstallCommand("pnpm install --frozen-lockfile --force --ignore-workspace", {
      dropIgnoreWorkspace: true,
    });

    expect(result).toEqual({
      command: "pnpm --config.minimumReleaseAge=0 --config.dangerouslyAllowAllBuilds=true install --no-frozen-lockfile --force",
      changed: true,
    });
  });

  it("does not duplicate a pnpm-11 config flag already present in the source command", () => {
    const result = normalizeBootstrapInstallCommand("pnpm install --config.minimumReleaseAge=0 --frozen-lockfile");

    expect(result.command).toBe("pnpm --config.dangerouslyAllowAllBuilds=true install --no-frozen-lockfile --config.minimumReleaseAge=0");
  });

  it("lets a caller override the injected pnpm config flags", () => {
    const result = normalizeBootstrapInstallCommand("pnpm install --frozen-lockfile", { pnpmConfig: ["--config.custom=true"] });

    expect(result.command).toBe("pnpm --config.custom=true install --no-frozen-lockfile");
  });

  it("passes an npm ci command through the pre-existing degrade-to-install behavior, unchanged by the pnpm-11 fix", () => {
    const result = normalizeBootstrapInstallCommand("npm ci");

    expect(result).toEqual({ command: "npm install", changed: true });
  });

  it("passes a yarn install command through the pre-existing frozen-flag stripping, unchanged by the pnpm-11 fix", () => {
    const result = normalizeBootstrapInstallCommand("corepack yarn install --immutable");

    expect(result).toEqual({ command: "corepack yarn install", changed: true });
  });

  it("passes a prefixed yarn install command through unchanged by the pnpm-11 fix", () => {
    const result = normalizeBootstrapInstallCommand(
      "YARN_ENABLE_HARDENED_MODE=false YARN_ENABLE_CONSTRAINTS_CHECKS=false corepack yarn install",
    );

    expect(result).toEqual({
      command: "YARN_ENABLE_HARDENED_MODE=false YARN_ENABLE_CONSTRAINTS_CHECKS=false corepack yarn install",
      changed: false,
    });
  });
});

describe("normalizePostInjectionInstallCommand (regression guard — unaffected by the bootstrap-path fix)", () => {
  it("still inserts pnpm config flags only when the caller supplies them (no default of its own)", () => {
    const withoutConfig = normalizePostInjectionInstallCommand("pnpm install --frozen-lockfile");
    expect(withoutConfig.command).toBe("pnpm install --no-frozen-lockfile");

    const withConfig = normalizePostInjectionInstallCommand("pnpm install --frozen-lockfile", {
      pnpmConfig: ["--config.minimumReleaseAge=0", "--config.dangerouslyAllowAllBuilds=true"],
    });
    expect(withConfig.command).toBe(
      "pnpm --config.minimumReleaseAge=0 --config.dangerouslyAllowAllBuilds=true install --no-frozen-lockfile",
    );
  });

  it("still normalizes a bare npm install (not just npm ci) — the deliberate difference from the bootstrap path", () => {
    const result = normalizePostInjectionInstallCommand("npm install");
    expect(result).toEqual({ command: "npm install", changed: false });
  });

  it("still supports disabling yarn immutable installs via an env prefix — the deliberate difference from the bootstrap path", () => {
    const result = normalizePostInjectionInstallCommand("yarn install --immutable", {
      disableYarnImmutableInstalls: true,
    });
    expect(result.command).toBe("YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install");
  });
});
