import { describe, expect, it } from "vitest";
import { loadManifest, parseManifest } from "../src/manifest.js";

const validSha = "0123456789abcdef0123456789abcdef01234567";

const entry = {
  name: "umami",
  gitUrl: "https://github.com/umami-software/umami.git",
  pinnedSha: validSha,
  license: "MIT",
  tier: "deep",
  bootstrap: {
    installCommand: "pnpm install --frozen-lockfile",
    envTemplate: {
      DATABASE_URL: "${CORPUS_UMAMI_DATABASE_URL}",
    },
    buildCommand: "pnpm build",
  },
  notes: "Verified as a Next.js app.",
};

describe("parseManifest", () => {
  it("accepts valid corpus entries", () => {
    expect(parseManifest([entry])).toEqual([{ ...entry, framework: "next" }]);
  });

  it("accepts a local source without git metadata and defaults its framework", () => {
    const { gitUrl: _gitUrl, pinnedSha: _pinnedSha, ...shared } = entry;
    expect(parseManifest([{ ...shared, localPath: "corpus/hosts/express-host" }])).toEqual([{
      ...shared,
      localPath: "corpus/hosts/express-host",
      framework: "next",
    }]);
  });

  it("accepts an explicit Express framework", () => {
    expect(parseManifest([{ ...entry, framework: "express" }])[0]?.framework).toBe("express");
  });

  it("accepts optional relative app directories", () => {
    expect(parseManifest([{ ...entry, appDir: "apps/web" }])[0]?.appDir).toBe("apps/web");
  });

  it("rejects app directories that can escape the checkout", () => {
    expect(() => parseManifest([{ ...entry, appDir: "../apps/web" }])).toThrow(/appDir/i);
    expect(() => parseManifest([{ ...entry, appDir: "/apps/web" }])).toThrow(/appDir/i);
  });

  it("rejects local paths that can escape the workspace", () => {
    const { gitUrl: _gitUrl, pinnedSha: _pinnedSha, ...shared } = entry;
    expect(() => parseManifest([{ ...shared, localPath: "../express-host" }])).toThrow(/localPath/i);
    expect(() => parseManifest([{ ...shared, localPath: "/corpus/hosts/express-host" }])).toThrow(/localPath/i);
  });

  it("requires exactly one complete git or local source", () => {
    expect(() => parseManifest([{ ...entry, localPath: "corpus/hosts/express-host" }])).toThrow(/localPath.*gitUrl|gitUrl.*localPath/i);
    const { pinnedSha: _pinnedSha, ...missingSha } = entry;
    expect(() => parseManifest([missingSha])).toThrow(/pinnedSha/i);
    const { gitUrl: _gitUrl, ...missingUrl } = entry;
    expect(() => parseManifest([missingUrl])).toThrow(/gitUrl/i);
  });

  it("rejects unknown tiers", () => {
    expect(() => parseManifest([{ ...entry, tier: "medium" }])).toThrow(/tier/i);
  });

  it("rejects duplicate repo names", () => {
    expect(() => parseManifest([entry, { ...entry }])).toThrow(/duplicate.*umami/i);
  });

  it("accepts an optional package-manager pin and rejects an empty one", () => {
    expect(parseManifest([{ ...entry, packageManager: "pnpm@10.33.4" }])[0]?.packageManager).toBe("pnpm@10.33.4");
    expect(parseManifest([entry])[0]?.packageManager).toBeUndefined();
    expect(() => parseManifest([{ ...entry, packageManager: "" }])).toThrow(/packageManager/i);
  });

  it("loads the committed corpus manifest", async () => {
    const manifest = await loadManifest();
    const names = manifest.map((repo) => repo.name);

    // The three original deep-tier repos must always be present; the broad
    // tier grows over time, so assert membership rather than an exact list.
    expect(names).toEqual(expect.arrayContaining(["umami", "skateshop", "papermark"]));
    expect(new Set(names).size).toBe(names.length);
    expect(manifest.find((repo) => repo.name === "express-host")).toMatchObject({
      localPath: "corpus/hosts/express-host",
      framework: "express",
      tier: "deep",
    });

    // nextcrm declares no packageManager upstream, so the manifest pins one and
    // drives its pnpm through corepack to keep that pin in force.
    expect(manifest.find((repo) => repo.name === "nextcrm")).toMatchObject({
      packageManager: "pnpm@10.33.4",
      bootstrap: {
        installCommand: expect.stringMatching(/^corepack pnpm /),
        typecheckCommand: expect.stringMatching(/^corepack pnpm /),
        buildCommand: expect.stringMatching(/^corepack pnpm /),
      },
    });
  });
});
