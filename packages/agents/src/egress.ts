/**
 * `agent({ egress })` — host code only, bound at box boot, never per-turn,
 * never from request content (the spec's egress law).
 *
 * The one seam every box passes through is the sandbox adapter's `create()`:
 * the harness computes its own minimum (inference host + door) and hands it
 * over as `allowedDomains`. Wrapping the adapter is therefore how an
 * agent-level list binds — a list ADDS to the minimum, `"all"` lifts the
 * restriction entirely, unset leaves the minimum alone — and where the one
 * audit row per box boot is written.
 */
import { VendoError } from "@vendoai/core";

export type EgressConfig = readonly string[] | "all" | undefined;

/** The slice of a sandbox adapter this seam touches (structural on purpose —
 *  `SandboxAdapterLike` in harnesses and `SandboxAdapter` in apps both fit). */
interface CreatesBoxes {
  create(spec: {
    template?: string;
    env: Record<string, string>;
    allowedDomains?: string[];
  }): Promise<unknown>;
}

const normalizeDomain = (domain: string): string => {
  const bare = domain.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
  if (bare === "") throw new VendoError("validation", `egress entry "${domain}" is not a hostname`);
  return bare;
};

export function resolveEgress(config: EgressConfig): string[] | "all" | undefined {
  if (config === undefined) return undefined;
  if (config === "all") return "all";
  return [...new Set(config.map(normalizeDomain))];
}

export function withEgress<A extends CreatesBoxes>(
  sandbox: A,
  config: EgressConfig,
  onBoxBoot: (domains: string[] | "all") => Promise<void> | void,
): A {
  const resolved = resolveEgress(config);
  const create: CreatesBoxes["create"] = async (spec) => {
    const { allowedDomains: fromHarness, ...rest } = spec;
    const allowedDomains =
      resolved === "all"
        ? undefined
        : resolved === undefined
          ? fromHarness
          : [...new Set([...(fromHarness ?? []), ...resolved])];
    await onBoxBoot(allowedDomains ?? "all");
    return sandbox.create({ ...rest, ...(allowedDomains === undefined ? {} : { allowedDomains }) });
  };
  return { ...sandbox, create } as A;
}
