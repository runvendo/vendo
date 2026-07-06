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
    expect(parseManifest([entry])).toEqual([entry]);
  });

  it("rejects entries missing a pinned SHA", () => {
    const { pinnedSha: _pinnedSha, ...missingSha } = entry;
    expect(() => parseManifest([missingSha])).toThrow(/pinnedSha/i);
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
    for (const repo of manifest.filter((entry) => ["umami", "skateshop", "papermark"].includes(entry.name))) {
      expect(repo.bootstrap.database?.kind).toBe("docker-postgres");
      expect(repo.bootstrap.devServer?.readinessTimeoutMs).toBeGreaterThan(0);
    }
  });
});
