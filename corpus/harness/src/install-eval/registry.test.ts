import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  indexLocalTarballs,
  readTarballManifest,
  startLocalNpmRegistry,
  type LocalNpmRegistry,
} from "./registry.js";

/** Build a minimal gzipped npm tarball containing package/package.json. */
function makeTarball(manifest: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(manifest), "utf8");
  const header = Buffer.alloc(512);
  header.write("package/package.json", 0, "utf8");
  header.write("0000644", 100, "utf8");
  header.write(body.length.toString(8).padStart(11, "0"), 124, "utf8");
  header.write("0", 156, "utf8");
  header.write("ustar", 257, "utf8");
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]));
}

const vendoManifest = {
  name: "@vendoai/vendo",
  version: "0.3.0",
  dependencies: { "@vendoai/core": "0.3.0" },
  bin: { vendo: "bin/vendo.mjs" },
};

let registry: LocalNpmRegistry | undefined;

afterEach(async () => {
  await registry?.close();
  registry = undefined;
});

describe("readTarballManifest", () => {
  it("reads name, version, pack-rewritten dependencies, and bin", () => {
    const manifest = readTarballManifest(makeTarball(vendoManifest));
    expect(manifest).toEqual({
      name: "@vendoai/vendo",
      version: "0.3.0",
      dependencies: { "@vendoai/core": "0.3.0" },
      bin: { vendo: "bin/vendo.mjs" },
    });
  });
});

describe("local npm registry", () => {
  it("serves local packuments and tarballs, redirects everything else upstream", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "install-eval-registry-"));
    await writeFile(path.join(dir, "vendoai-vendo-0.3.0.tgz"), makeTarball(vendoManifest));
    const packages = await indexLocalTarballs(dir);
    expect([...packages.keys()]).toEqual(["@vendoai/vendo"]);

    registry = await startLocalNpmRegistry({ tarballDir: dir, packages, upstream: "https://registry.example" });

    // Packument for a local package, requested npm-style (scoped name encoded).
    const packumentResponse = await fetch(`${registry.url}/@vendoai%2fvendo`);
    expect(packumentResponse.status).toBe(200);
    const packument = await packumentResponse.json() as {
      "dist-tags": { latest: string };
      versions: Record<string, { dependencies: Record<string, string>; bin?: Record<string, string>; dist: { tarball: string; integrity: string } }>;
    };
    expect(packument["dist-tags"].latest).toBe("0.3.0");
    expect(packument.versions["0.3.0"]?.dependencies).toEqual({ "@vendoai/core": "0.3.0" });
    // npm links CLI bins from the packument's version metadata, not the
    // extracted package.json — omitting bin here means no node_modules/.bin
    // symlink and a vendo-cli-missing doctor failure (install-E2E finding).
    expect(packument.versions["0.3.0"]?.bin).toEqual({ vendo: "bin/vendo.mjs" });

    // The advertised tarball downloads from this server.
    const tarballResponse = await fetch(packument.versions["0.3.0"]!.dist.tarball);
    expect(tarballResponse.status).toBe(200);
    const bytes = Buffer.from(await tarballResponse.arrayBuffer());
    expect(readTarballManifest(bytes).name).toBe("@vendoai/vendo");

    // Anything else 302s to the upstream registry.
    const redirect = await fetch(`${registry.url}/left-pad`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("https://registry.example/left-pad");
  });
});
