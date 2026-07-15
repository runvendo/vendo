import { describe, expect, it } from "vitest";
import { loadManifest, parseManifest } from "./manifest.js";

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
    seedCommand: "pnpm seed-data",
    database: {
      kind: "docker-postgres",
      containerName: "vendo-corpus-umami-postgres",
      image: "postgres:16-alpine",
      hostPort: 55432,
      database: "umami",
      username: "corpus",
      password: "corpus",
      readinessTimeoutMs: 30_000,
    },
    buildCommand: "pnpm build",
    devServer: {
      command: "pnpm dev",
      readinessUrl: "http://127.0.0.1:3000",
      readinessTimeoutMs: 30_000,
    },
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

  it("rejects invalid deep-tier docker database provisioning", () => {
    const invalid = {
      ...entry,
      bootstrap: {
        ...entry.bootstrap,
        database: {
          ...entry.bootstrap.database,
          hostPort: 70000,
        },
      },
    };

    expect(() => parseManifest([invalid])).toThrow(/hostPort/i);
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
    for (const repo of manifest.filter((entry) => ["umami", "skateshop", "papermark"].includes(entry.name))) {
      expect(repo.bootstrap.database?.kind).toBe("docker-postgres");
      expect(repo.bootstrap.devServer?.readinessTimeoutMs).toBeGreaterThan(0);
    }

    expect(manifest.find((repo) => repo.name === "teable")).toMatchObject({
      appDir: "apps/nextjs-app",
      tier: "deep",
      bootstrap: {
        envTemplate: {
          PRISMA_DATABASE_URL: "postgresql://corpus:corpus@127.0.0.1:55436/teable?schema=public&statement_cache_size=0",
        },
        seedCommand: expect.stringContaining("prisma-db-seed -- --e2e"),
        database: {
          kind: "docker-postgres",
          containerName: "vendo-corpus-teable-postgres",
          hostPort: 55436,
        },
        devServer: {
          command: "corepack pnpm --dir ../nestjs-backend exec dotenv-flow -p ../nextjs-app -- nest start --webpackPath ./webpack.swc.js -w",
          readinessUrl: "http://127.0.0.1:43105/auth/login",
          readinessBodyContains: "Teable",
        },
      },
    });
  });
});
