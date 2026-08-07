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

function withoutYarnFrozenFlags(args: readonly string[]): string[] {
  return args.filter((arg) => {
    if (arg === "--frozen-lockfile" || arg.startsWith("--frozen-lockfile=")) return false;
    if (arg === "--immutable" || arg.startsWith("--immutable=")) return false;
    if (arg === "--immutable-cache" || arg.startsWith("--immutable-cache=")) return false;
    if (arg === "--check-cache" || arg.startsWith("--check-cache=")) return false;
    return true;
  });
}

function hasShellEnvAssignment(words: readonly string[], key: string): boolean {
  return words.some((word) => word.startsWith(`${key}=`));
}

/** pnpm 11 defaults strictDepBuilds/minimumReleaseAge on; without these config
 * flags a bootstrap install of a repo with native build-script deps (sharp,
 * prisma, ...) fails before the harness ever gets to inject Vendo. This is
 * the same accommodation `normalizePostInjectionInstallCommand` already
 * makes (ENG-332); the bootstrap path just never got it. Defaulted here
 * (rather than threaded through every call site) so the fix applies to every
 * pnpm bootstrap install command in the corpus manifest without touching
 * bootstrap.ts. */
const BOOTSTRAP_PNPM11_CONFIG_ARGS: readonly string[] = [
  "--config.minimumReleaseAge=0",
  "--config.dangerouslyAllowAllBuilds=true",
];

export function normalizeBootstrapInstallCommand(
  command: string,
  options: { dropIgnoreWorkspace?: boolean; pnpmConfig?: readonly string[] } = {},
): NormalizedInstallCommand {
  const words = shellWords(command);
  const pnpmIndex = words.indexOf("pnpm");
  if (pnpmIndex >= 0 && words[pnpmIndex + 1] === "install") {
    const configArgs = (options.pnpmConfig ?? BOOTSTRAP_PNPM11_CONFIG_ARGS).filter((arg) => !words.includes(arg));
    const normalized = [
      ...words.slice(0, pnpmIndex + 1),
      ...configArgs,
      words[pnpmIndex + 1],
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

  const yarnIndex = words.indexOf("yarn");
  if (yarnIndex >= 0 && words[yarnIndex + 1] === "install") {
    const normalized = [
      ...words.slice(0, yarnIndex + 2),
      ...withoutYarnFrozenFlags(words.slice(yarnIndex + 2)),
    ].join(" ");
    return { command: normalized, changed: normalized !== command.trim() };
  }

  return { command, changed: false };
}

export function normalizePostInjectionInstallCommand(
  command: string,
  options: { dropIgnoreWorkspace?: boolean; disableYarnImmutableInstalls?: boolean; pnpmConfig?: readonly string[] } = {},
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

  const yarnIndex = words.indexOf("yarn");
  if (yarnIndex >= 0 && words[yarnIndex + 1] === "install") {
    const envPrefix = options.disableYarnImmutableInstalls && !hasShellEnvAssignment(words, "YARN_ENABLE_IMMUTABLE_INSTALLS")
      ? ["YARN_ENABLE_IMMUTABLE_INSTALLS=false"]
      : [];
    const normalized = [
      ...envPrefix,
      ...words.slice(0, yarnIndex + 2),
      ...withoutYarnFrozenFlags(words.slice(yarnIndex + 2)),
    ].join(" ");
    return { command: normalized, changed: normalized !== command.trim() };
  }

  return { command, changed: false };
}
