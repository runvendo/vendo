/**
 * `.flowlet/mcp.json` schema + resolution for host-declared MCP servers.
 *
 * The file holds the SAME shape as the `mcpServers` handler option, wrapped in
 * a versioned envelope (like tools.json). Header values may reference env vars
 * as `${VAR_NAME}` so tokens never live in the checked-in file. A server whose
 * referenced var is missing/empty is DROPPED with a boot warning — fail
 * closed, never send empty auth.
 *
 * SECURITY INVARIANT: server URLs and header templates come ONLY from the
 * host's code (`mcpServers` option) or its repo (`.flowlet/mcp.json`) — never
 * from request input. The URL schema is deliberately NOT an SSRF guard
 * (localhost/private ranges are legitimate for host-declared servers); any
 * future user-added-server feature MUST add network denylisting before
 * accepting URLs from users.
 */
import { z } from "zod";
import type { McpServerConfig } from "@flowlet/runtime";

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

/** Reject duplicate server names — they'd alias each other's tools and clients. */
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
});

export const mcpJsonSchema = z
  .object({
    version: z.literal(1),
    servers: mcpServerArraySchema,
  })
  .strict();

export type McpJson = z.infer<typeof mcpJsonSchema>;

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
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.headers)) {
      headers[key] = value.replace(ENV_REF, (_, varName: string) => {
        const v = env[varName];
        if (v === undefined || v.trim() === "") missing = varName;
        return v ?? "";
      });
    }
    if (missing) {
      console.warn(
        `[flowlet] MCP server "${server.name}" dropped: header references env var ` +
          `\${${missing}} which is not set.`,
      );
      continue;
    }
    resolved.push({ ...server, headers });
  }
  return resolved;
}
