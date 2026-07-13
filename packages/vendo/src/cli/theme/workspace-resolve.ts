import { promises as fs } from "node:fs";
import path from "node:path";

const PACKAGE_DIR_GLOBS = [
  ["packages"],
  ["packages", "*"],
  ["apps"],
  ["plugins"],
];

const RESOLVE_EXTENSIONS = ["", ".css", ".ts", ".tsx", ".js", ".mjs", ".cjs"];

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

async function tryFile(file: string): Promise<string | null> {
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = ext === "" || file.endsWith(ext) ? file : `${file}${ext}`;
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function findWorkspaceRoot(fromDir: string): Promise<string> {
  let dir = fromDir;
  while (true) {
    if (await exists(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    if (await exists(path.join(dir, "packages"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return fromDir;
    dir = parent;
  }
}

async function packageDirs(root: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const parts of PACKAGE_DIR_GLOBS) {
    const base = path.join(root, ...parts);
    const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      if (await exists(path.join(dir, "package.json"))) dirs.push(dir);
      const nested = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const child of nested) {
        if (!child.isDirectory()) continue;
        const childDir = path.join(dir, child.name);
        if (await exists(path.join(childDir, "package.json"))) dirs.push(childDir);
      }
    }
  }
  return dirs;
}

function splitPackageSpecifier(spec: string): { packageName: string; subpath: string } | null {
  const parts = spec.split("/");
  if (spec.startsWith("@")) {
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return { packageName: `${parts[0]}/${parts[1]}`, subpath: parts.slice(2).join("/") };
  }
  if (!parts[0]) return null;
  return { packageName: parts[0], subpath: parts.slice(1).join("/") };
}

function exportTarget(exportsField: unknown, key: string): string | null {
  if (typeof exportsField === "string") return key === "." ? exportsField : null;
  if (!exportsField || typeof exportsField !== "object") return null;
  const entry = (exportsField as Record<string, unknown>)[key];
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const conditions = entry as Record<string, unknown>;
    for (const condition of ["default", "import", "require", "types"]) {
      if (typeof conditions[condition] === "string") return conditions[condition];
    }
  }
  return null;
}

async function resolvePackageExport(packageDir: string, subpath: string): Promise<string | null> {
  const pkg = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8")) as {
    exports?: unknown;
    main?: string;
    module?: string;
  };
  const key = subpath ? `./${subpath}` : ".";
  const target = exportTarget(pkg.exports, key) ?? exportTarget(pkg.exports, `${key}.css`);
  if (target) {
    const resolved = await tryFile(path.join(packageDir, target));
    if (resolved) return resolved;
    if (target.includes("/dist/")) {
      const sourceTarget = target.replace("/dist/", "/src/");
      const sourceResolved = await tryFile(path.join(packageDir, sourceTarget));
      if (sourceResolved) return sourceResolved;
    }
  }
  if (!subpath) {
    const main = pkg.module ?? pkg.main;
    if (main) return tryFile(path.join(packageDir, main));
  }
  return null;
}

/** Resolve workspace package specifiers in uninstalled monorepos. */
export async function resolveWorkspacePackageSpecifier(spec: string, fromDir: string): Promise<string | null> {
  const parsed = splitPackageSpecifier(spec);
  if (!parsed) return null;
  const root = await findWorkspaceRoot(fromDir);
  for (const dir of await packageDirs(root)) {
    const pkgPath = path.join(dir, "package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as { name?: string };
    if (pkg.name !== parsed.packageName) continue;
    const exported = await resolvePackageExport(dir, parsed.subpath);
    if (exported) return exported;
    for (const base of [dir, path.join(dir, "src"), path.join(dir, "dist")]) {
      const resolved = await tryFile(path.join(base, parsed.subpath));
      if (resolved) return resolved;
    }
    return null;
  }
  return null;
}
