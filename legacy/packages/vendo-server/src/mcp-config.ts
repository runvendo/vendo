/**
 * `.vendo/mcp.json` schema + resolution for host-declared MCP servers.
 *
 * The file holds the SAME shape as the `mcpServers` handler option, wrapped in
 * a versioned envelope (like tools.json). Header values may reference env vars
 * as `${VAR_NAME}` so tokens never live in the checked-in file. A server whose
 * referenced var is missing/empty is DROPPED with a boot warning — fail
 * closed, never send empty auth.
 *
 * SECURITY INVARIANT: server URLs and header templates come ONLY from the
 * host's code (`mcpServers` option) or its repo (`.vendo/mcp.json`) — never
 * from request input. The URL schema is deliberately NOT an SSRF guard
 * (localhost/private ranges are legitimate for host-declared servers); any
 * future user-added-server feature MUST add network denylisting before
 * accepting URLs from users.
 */
import { z } from "zod";
import type { McpServerConfig } from "@vendoai/runtime";

/** Matches `<serverName>_<toolName>` tool-name rules (letters, digits, _ , -). */
const NAME_FRAGMENT = /^[A-Za-z0-9_-]+$/;

export const mcpServerSchema = z
  .object({
    name: z.string().regex(NAME_FRAGMENT, "server name must be letters, digits, _ or -"),
    url: z
      .string()
      .url()
      .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
        message: "MCP server URL must be http(s)",
      }),
    headers: z.record(z.string()).optional(),
    tools: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Reject duplicate server names (they'd alias each other's tools and clients)
 * AND prefix-ambiguous pairs like "a" and "a_b": server "a" exposing a tool
 * "b_c" would collide with server "a_b" exposing "c" under the final name
 * "a_b_c", letting one server squat the other's canonical tool names.
 */
export const mcpServerArraySchema = z.array(mcpServerSchema).superRefine((servers, ctx) => {
  const seen = new Set<string>();
  for (const s of servers) {
    if (seen.has(s.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate MCP server name "${s.name}"`,
      });
    }
    seen.add(s.name);
  }
  for (const a of servers) {
    for (const b of servers) {
      if (a !== b && b.name.startsWith(`${a.name}_`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `ambiguous MCP server names "${a.name}" and "${b.name}": ` +
            `one extends the other with "_", so their prefixed tool names can collide`,
        });
      }
    }
  }
});

export const mcpJsonSchema = z
  .object({
    version: z.literal(1),
    servers: mcpServerArraySchema,
  })
  .strict();

const ENV_REF = /\$\{([A-Z0-9_]+)\}/g;

/**
 * Substitute `${VAR}` references in header values from `env`. A server that
 * references a missing/empty var is dropped with a warning.
 */
export function resolveMcpServers(
  servers: McpServerConfig[],
  env: Record<string, string | undefined> = process.env,
): McpServerConfig[] {
  const resolved: McpServerConfig[] = [];
  for (const server of servers) {
    if (!server.headers) {
      resolved.push(server);
      continue;
    }
    let missing: string | null = null;
    let residue: string | null = null;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.headers)) {
      const substituted = value.replace(ENV_REF, (_, varName: string) => {
        const v = env[varName];
        if (v === undefined || v.trim() === "") missing = varName;
        return v ?? "";
      });
      // Anything still looking like a template (lowercase names, dashes,
      // typos) would otherwise be sent to the server literally — fail closed.
      if (substituted.includes("${")) residue = key;
      headers[key] = substituted;
    }
    if (missing) {
      console.warn(
        `[vendo] MCP server "${server.name}" dropped: header references env var ` +
          `\${${missing}} which is not set.`,
      );
      continue;
    }
    if (residue) {
      console.warn(
        `[vendo] MCP server "${server.name}" dropped: header "${residue}" still ` +
          "contains an unresolved ${...} template (env var names must be UPPERCASE_WITH_UNDERSCORES).",
      );
      continue;
    }
    resolved.push({ ...server, headers });
  }
  return resolved;
}
