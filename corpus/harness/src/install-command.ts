export interface NormalizedInstallCommand {
  command: string;
  changed: boolean;
}

function shellWords(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function withoutPnpmFrozenFlags(args: readonly string[], options: { dropIgnoreWorkspace?: boolean } = {}): string[] {
  const next = args.filter((arg) => {
    if (arg === "--frozen-lockfile" || arg.startsWith("--frozen-lockfile=")) return false;
    if (arg === "--prefer-frozen-lockfile" || arg.startsWith("--prefer-frozen-lockfile=")) return false;
    if (options.dropIgnoreWorkspace && arg === "--ignore-workspace") return false;
    return true;
  });
  return next.includes("--no-frozen-lockfile") ? next : ["--no-frozen-lockfile", ...next];
}

export function normalizeBootstrapInstallCommand(
  command: string,
  options: { dropIgnoreWorkspace?: boolean } = {},
): NormalizedInstallCommand {
  const words = shellWords(command);
  const pnpmIndex = words.indexOf("pnpm");
  if (pnpmIndex >= 0 && words[pnpmIndex + 1] === "install") {
    const normalized = [
      ...words.slice(0, pnpmIndex + 2),
      ...withoutPnpmFrozenFlags(words.slice(pnpmIndex + 2), options),
    ].join(" ");
    return { command: normalized, changed: normalized !== command.trim() };
  }

  const npmIndex = words.indexOf("npm");
  if (npmIndex >= 0 && words[npmIndex + 1] === "ci") {
    const normalized = [
      ...words.slice(0, npmIndex + 1),
      "install",
      ...words.slice(npmIndex + 2),
    ].join(" ");
    return { command: normalized, changed: normalized !== command.trim() };
  }

  return { command, changed: false };
}

export function normalizePostInjectionInstallCommand(
  command: string,
  options: { dropIgnoreWorkspace?: boolean; pnpmConfig?: readonly string[] } = {},
): NormalizedInstallCommand {
  const words = shellWords(command);
  const pnpmIndex = words.indexOf("pnpm");
  if (pnpmIndex >= 0 && words[pnpmIndex + 1] === "install") {
    const configArgs = (options.pnpmConfig ?? []).filter((arg) => !words.includes(arg));
    const normalized = [
      ...words.slice(0, pnpmIndex + 1),
      ...configArgs,
      words[pnpmIndex + 1],
      ...withoutPnpmFrozenFlags(words.slice(pnpmIndex + 2), options),
    ].join(" ");
    return { command: normalized, changed: normalized !== command.trim() };
  }

  const npmIndex = words.indexOf("npm");
  if (npmIndex >= 0 && (words[npmIndex + 1] === "ci" || words[npmIndex + 1] === "install")) {
    const normalized = [
      ...words.slice(0, npmIndex + 1),
      "install",
      ...words.slice(npmIndex + 2),
    ].join(" ");
    return { command: normalized, changed: normalized !== command.trim() };
  }

  return { command, changed: false };
}
