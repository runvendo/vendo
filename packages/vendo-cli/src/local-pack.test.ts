import { describe, expect, it } from "vitest";
import { rewritePackageJsonForLocalVendo, type LocalTarball } from "./local-pack.js";

const LOCAL_TARBALLS: LocalTarball[] = [
  { name: "@vendoai/components", fileName: "vendoai-components-0.0.0.tgz" },
  { name: "@vendoai/core", fileName: "vendoai-core-0.0.0.tgz" },
  { name: "@vendoai/next", fileName: "vendoai-next-0.0.0.tgz" },
  { name: "@vendoai/react", fileName: "vendoai-react-0.0.0.tgz" },
  { name: "@vendoai/runtime", fileName: "vendoai-runtime-0.0.0.tgz" },
  { name: "@vendoai/server", fileName: "vendoai-server-0.0.0.tgz" },
  { name: "@vendoai/shell", fileName: "vendoai-shell-0.0.0.tgz" },
  { name: "@vendoai/stage", fileName: "vendoai-stage-0.0.0.tgz" },
  { name: "@vendoai/store", fileName: "vendoai-store-0.0.0.tgz" },
  { name: "@vendoai/telemetry", fileName: "vendoai-telemetry-0.0.0.tgz" },
  { name: "fluidkit", fileName: "fluidkit-0.5.0-656857b.tgz" },
];

describe("rewritePackageJsonForLocalVendo", () => {
  it("writes direct file dependencies and pnpm overrides for every local tarball", () => {
    const out = rewritePackageJsonForLocalVendo(
      JSON.stringify({
        name: "host",
        packageManager: "pnpm@9.12.0",
        dependencies: { next: "16.0.0", "@vendoai/next": "latest" },
        pnpm: { overrides: { "@types/react": "^19.2.0" } },
      }),
      LOCAL_TARBALLS,
      { packageManager: "pnpm" },
    );
    expect(out).not.toBeNull();
    const pkg = JSON.parse(out!) as {
      dependencies: Record<string, string>;
      pnpm: { overrides: Record<string, string> };
    };
    expect(pkg.dependencies["@vendoai/next"]).toBe("file:vendor/vendoai-next-0.0.0.tgz");
    expect(pkg.dependencies["@vendoai/shell"]).toBe("file:vendor/vendoai-shell-0.0.0.tgz");
    expect(pkg.dependencies["next"]).toBe("16.0.0");
    for (const tarball of LOCAL_TARBALLS) {
      expect(pkg.pnpm.overrides[tarball.name]).toBe(`file:vendor/${tarball.fileName}`);
    }
    expect(pkg.pnpm.overrides["@types/react"]).toBe("^19.2.0");
  });

  it("uses npm overrides as the fallback package-manager shape", () => {
    const out = rewritePackageJsonForLocalVendo(
      JSON.stringify({
        name: "host",
        dependencies: { react: "^19.0.0" },
        overrides: { zod: "^3.24.0" },
      }),
      LOCAL_TARBALLS,
      { packageManager: "npm" },
    );
    expect(out).not.toBeNull();
    const pkg = JSON.parse(out!) as {
      dependencies: Record<string, string>;
      overrides: Record<string, string>;
      pnpm?: unknown;
    };
    expect(pkg.dependencies["@vendoai/next"]).toBe("file:vendor/vendoai-next-0.0.0.tgz");
    expect(pkg.dependencies["@vendoai/shell"]).toBe("file:vendor/vendoai-shell-0.0.0.tgz");
    expect(pkg.overrides["@vendoai/core"]).toBe("file:vendor/vendoai-core-0.0.0.tgz");
    expect(pkg.overrides["fluidkit"]).toBe("file:vendor/fluidkit-0.5.0-656857b.tgz");
    expect(pkg.overrides["zod"]).toBe("^3.24.0");
    expect(pkg.pnpm).toBeUndefined();
  });

  it("returns null for invalid package.json or incomplete tarball maps", () => {
    expect(rewritePackageJsonForLocalVendo("{nope", LOCAL_TARBALLS, { packageManager: "pnpm" })).toBeNull();
    expect(
      rewritePackageJsonForLocalVendo("{}", LOCAL_TARBALLS.filter((tarball) => tarball.name !== "fluidkit"), {
        packageManager: "pnpm",
      }),
    ).toBeNull();
  });
});
