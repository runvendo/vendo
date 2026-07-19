/** Deployment-identity headers (cloud definition, interaction model): every
 * key-authenticated Vendo Cloud request carries `x-vendo-deployment-host` and
 * `x-vendo-deployment-name`; the console's shared auth middleware upserts the
 * deployment inventory and meters usage from these on real service calls —
 * there is no heartbeat. Shared by the CLI cloud client and the runtime Cloud
 * adapters (connections, sandbox), so this module carries NO static Node
 * import: builtins load through the runtime accessor (server.ts precedent)
 * and every lookup fails soft to "unknown" on edge/Worker targets — identity
 * headers must never take a request down. The console truncates and fails
 * open on its side (parseDeploymentHeaders), so sending is always safe. */

type RuntimeProcess = {
  getBuiltinModule?: (id: string) => unknown;
  cwd?: () => string;
};

function runtimeProcess(): RuntimeProcess | undefined {
  return (globalThis as { process?: RuntimeProcess }).process;
}

function builtinModule<T>(id: string): T | undefined {
  try {
    return runtimeProcess()?.getBuiltinModule?.(id) as T | undefined;
  } catch {
    return undefined;
  }
}

/** Non-Latin-1 or CR/LF header values make fetch throw "Cannot convert
 *  argument to a ByteString"; identity headers must never take a command
 *  down, so strip to printable ASCII and never send an empty value. */
export function headerSafe(value: string): string {
  const printable = value.replace(/[^\x20-\x7e]+/g, "").trim();
  return printable.length > 0 ? printable : "unknown";
}

/** Name is the nearest project identity: the cwd package name, cached per
 *  directory (a process can chdir between calls). */
const deploymentNames = new Map<string, Promise<string>>();

export function resolveDeploymentName(cwd: string): Promise<string> {
  let name = deploymentNames.get(cwd);
  if (name === undefined) {
    name = (async () => {
      const path = builtinModule<typeof import("node:path")>("node:path");
      const fs = builtinModule<typeof import("node:fs")>("node:fs");
      try {
        const manifestPath = path === undefined ? `${cwd}/package.json` : path.join(cwd, "package.json");
        const manifest = JSON.parse(fs!.readFileSync(manifestPath, "utf8")) as { name?: unknown };
        if (typeof manifest.name === "string" && manifest.name.length > 0) return manifest.name;
      } catch {
        // no manifest (or no filesystem) — fall through to the directory name
      }
      if (path !== undefined) return path.basename(cwd);
      return cwd.split(/[/\\]/).filter(Boolean).pop() ?? "";
    })();
    deploymentNames.set(cwd, name);
  }
  return name;
}

/** The two identity headers for a key-authenticated Cloud request. */
export async function deploymentIdentityHeaders(): Promise<Record<string, string>> {
  const os = builtinModule<typeof import("node:os")>("node:os");
  let cwd: string | undefined;
  try {
    cwd = runtimeProcess()?.cwd?.();
  } catch {
    cwd = undefined;
  }
  return {
    "x-vendo-deployment-host": headerSafe(os === undefined ? "" : os.hostname()),
    "x-vendo-deployment-name": headerSafe(cwd === undefined ? "" : await resolveDeploymentName(cwd)),
  };
}
