import { capturedPinBaselineSchema, type CapturedPinBaseline } from "@vendoai/actions";
import { sha256Hex, VendoError } from "@vendoai/core";

export interface RuntimeCaptureRegistration {
  slot: string;
  source: string;
  exportable: boolean;
}

export interface RuntimeCaptureResult {
  slot: string;
  hash: string;
  status: "captured" | "unchanged" | "preserved";
}

export interface RuntimeCaptureHandler {
  capture(registration: RuntimeCaptureRegistration): Promise<RuntimeCaptureResult>;
}

type FsModule = typeof import("node:fs");
type PathModule = typeof import("node:path");
type UrlModule = typeof import("node:url");

function nodeModules(): { fs: FsModule; path: PathModule; url: UrlModule; cwd: () => string } | null {
  const proc = (globalThis as {
    process?: {
      cwd?: () => string;
      getBuiltinModule?: (id: string) => unknown;
    };
  }).process;
  if (!proc?.cwd || !proc.getBuiltinModule) return null;
  const fs = proc.getBuiltinModule("node:fs") as FsModule | undefined;
  const path = proc.getBuiltinModule("node:path") as PathModule | undefined;
  const url = proc.getBuiltinModule("node:url") as UrlModule | undefined;
  return fs && path && url ? { fs, path, url, cwd: proc.cwd } : null;
}

function isInside(path: PathModule, root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sourceCandidates(
  path: PathModule,
  url: UrlModule,
  root: string,
  source: string,
): string[] {
  if (source.startsWith("file:")) {
    try {
      return [url.fileURLToPath(source)];
    } catch {
      return [];
    }
  }
  let clean = source.split(/[?#]/, 1)[0] ?? source;
  // A dev browser's import.meta.url is an http(s) module URL (Vite serves
  // /src/... under the dev origin). Only its pathname matters: the realpath
  // root-confinement below decides what is actually readable.
  if (/^https?:\/\//iu.test(clean)) {
    try {
      clean = decodeURIComponent(new URL(clean).pathname);
    } catch {
      return [];
    }
  }
  if (clean.startsWith("/@fs/")) return [path.resolve(clean.slice(4))];
  if (path.isAbsolute(clean)) {
    const candidates = [path.resolve(clean)];
    // Vite-style project-root ids use `/src/...`, not an absolute filesystem path.
    if (clean.startsWith("/src/")) candidates.push(path.resolve(root, clean.slice(1)));
    return candidates;
  }
  return [path.resolve(root, clean)];
}

async function existingBaseline(fs: FsModule, file: string): Promise<CapturedPinBaseline | null> {
  try {
    return capturedPinBaselineSchema.parse(JSON.parse(await fs.promises.readFile(file, "utf8")));
  } catch {
    return null;
  }
}

/** Node-only capture primitive. Returning null keeps edge/Worker bundles file-system free. */
export function createRuntimeCapture(config: { root?: string; out?: string }): RuntimeCaptureHandler | null {
  const modules = nodeModules();
  if (!modules) return null;
  const { fs, path, url } = modules;
  const root = path.resolve(config.root ?? modules.cwd());
  const out = path.resolve(config.out ?? path.join(root, ".vendo"));
  let realRootPromise: Promise<string> | undefined;

  return {
    async capture(registration) {
      const remixableDir = path.resolve(out, "remixable");
      const baselineFile = path.resolve(remixableDir, `${registration.slot}.json`);
      if (!isInside(path, remixableDir, baselineFile)) {
        throw new VendoError("validation", "remixable slot is not a safe baseline filename");
      }

      realRootPromise ??= fs.promises.realpath(root);
      const realRoot = await realRootPromise;
      let realSource: string | undefined;
      for (const candidate of sourceCandidates(path, url, root, registration.source)) {
        try {
          const resolved = await fs.promises.realpath(candidate);
          if (isInside(path, realRoot, resolved)) {
            realSource = resolved;
            break;
          }
        } catch {
          // Try the next bundler-id interpretation.
        }
      }
      if (realSource === undefined) {
        throw new VendoError("validation", "runtime capture source must resolve inside the host root");
      }

      const source = await fs.promises.readFile(realSource, "utf8");
      const hash = `sha256:${sha256Hex(source)}`;
      const existing = await existingBaseline(fs, baselineFile);
      if (existing?.hash === hash) return { slot: registration.slot, hash, status: "unchanged" };
      // Static extraction is primary. A valid baseline may have been refreshed by
      // sync after this browser bundle loaded, so runtime capture only fills gaps.
      if (existing !== null) return { slot: registration.slot, hash: existing.hash, status: "preserved" };

      const baseline: CapturedPinBaseline = {
        slot: registration.slot,
        source,
        hash,
        exportable: registration.exportable,
        capturedAt: new Date().toISOString(),
      };
      await fs.promises.mkdir(remixableDir, { recursive: true });
      await fs.promises.writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
      return { slot: registration.slot, hash, status: "captured" };
    },
  };
}
