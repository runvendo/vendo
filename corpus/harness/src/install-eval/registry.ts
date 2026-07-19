import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * A minimal local npm registry so the agent's own `npm install vendoai`
 * resolves to the locally packed workspace build. The corpus injector's
 * overrides approach cannot be used here: npm rejects a direct
 * `npm install vendoai` when the root also carries a vendoai override
 * (EOVERRIDE, verified empirically), and the whole point of the eval is
 * that the AGENT runs the install command from the playbook. The fixture's
 * `.npmrc` points `registry=` at this server; requests for Vendo packages
 * are served from local tarballs, everything else is a 302 redirect to the
 * upstream registry (npm's fetcher follows redirects).
 */

export interface LocalRegistryPackage {
  name: string;
  version: string;
  tarballFile: string;
  dependencies: Record<string, string>;
}

/** Read `package/package.json` out of an npm tarball (gzip + ustar). The
 * packed manifest is the truth: pnpm pack has already rewritten workspace:*
 * specs into real versions there. */
export function readTarballManifest(tarball: Buffer): { name: string; version: string; dependencies: Record<string, string> } {
  const tar = gunzipSync(tarball);
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (name === "") break;
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim(), 8) || 0;
    if (name === "package/package.json") {
      const manifest = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString("utf8")) as {
        name?: string;
        version?: string;
        dependencies?: Record<string, string>;
      };
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
        throw new Error("tarball package/package.json lacks name/version");
      }
      return { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies ?? {} };
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("package/package.json not found in tarball");
}

/** Index every *.tgz in a directory by package name. */
export async function indexLocalTarballs(tarballDir: string): Promise<Map<string, LocalRegistryPackage>> {
  const packages = new Map<string, LocalRegistryPackage>();
  for (const entry of (await readdir(tarballDir)).filter((file) => file.endsWith(".tgz")).sort()) {
    const manifest = readTarballManifest(await readFile(path.join(tarballDir, entry)));
    packages.set(manifest.name, {
      name: manifest.name,
      version: manifest.version,
      tarballFile: entry,
      dependencies: manifest.dependencies,
    });
  }
  return packages;
}

export interface LocalNpmRegistry {
  url: string;
  close(): Promise<void>;
}

export interface StartLocalNpmRegistryOptions {
  tarballDir: string;
  packages: Map<string, LocalRegistryPackage>;
  upstream?: string;
  host?: string;
}

function packumentFor(pkg: LocalRegistryPackage, registryUrl: string, tarball: Buffer): unknown {
  return {
    name: pkg.name,
    "dist-tags": { latest: pkg.version },
    versions: {
      [pkg.version]: {
        name: pkg.name,
        version: pkg.version,
        dependencies: pkg.dependencies,
        dist: {
          tarball: `${registryUrl}/-/local/${pkg.tarballFile}`,
          shasum: createHash("sha1").update(tarball).digest("hex"),
          integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
        },
      },
    },
  };
}

export async function startLocalNpmRegistry(options: StartLocalNpmRegistryOptions): Promise<LocalNpmRegistry> {
  const upstream = (options.upstream ?? "https://registry.npmjs.org").replace(/\/$/, "");
  const host = options.host ?? "127.0.0.1";

  const server: Server = createServer((req, res) => {
    void (async () => {
      const requestPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
      const name = requestPath.replace(/^\//, "");

      if (name.startsWith("-/local/")) {
        const file = path.join(options.tarballDir, path.basename(name));
        const data = await readFile(file);
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length });
        res.end(data);
        return;
      }

      const pkg = options.packages.get(name);
      if (pkg) {
        const tarball = await readFile(path.join(options.tarballDir, pkg.tarballFile));
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(packumentFor(pkg, `http://${host}:${port}`, tarball)));
        return;
      }

      res.writeHead(302, { location: `${upstream}${req.url ?? "/"}` });
      res.end();
    })().catch((error: unknown) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("local registry failed to bind");

  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
    }),
  };
}
