import type { HttpMethod, PrimitiveToolBinding } from "./formats.js";

/**
 * Tool identity, kept PURE (no node imports) so both halves of the package can
 * reach it: sync computes it to diff and dedup, and the judgment layer — which
 * lives on the runtime side of the node-only boundary — compares it to decide
 * whether a stored judgment still describes the handler in front of it.
 */

export function dedupKey(method: HttpMethod, urlPath: string): string {
  return `${method} ${urlPath.replace(/\{[^}]+\}/g, "{}").replace(/\/+$/g, "") || "/"}`;
}

/** The binding-kind-aware identity a tool is deduplicated and diffed by:
 * method+path for HTTP-shaped bindings, mount+procedure for tRPC (a host can
 * expose the same procedure name under two mounts — both tools must survive),
 * module+export for server actions. */
export function bindingIdentity(binding: PrimitiveToolBinding): string {
  if (binding.kind === "trpc") return `TRPC ${binding.mount.replace(/\/+$/g, "")} ${binding.procedure}`;
  if (binding.kind === "server-action") return `SERVER-ACTION ${binding.module}#${binding.exportName}`;
  return dedupKey(binding.method, binding.path);
}
