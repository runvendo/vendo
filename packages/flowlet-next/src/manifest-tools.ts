/**
 * `.flowlet/tools.json` → host tool definitions.
 *
 * The manifest is the reviewable source of truth the extractor writes; the
 * runtime (server caller seam) and the browser executor both consume
 * `HostToolDefinition`s. One deterministic conversion feeds both sides, using
 * the manifest's documented conventions: input-schema properties whose name
 * appears in the binding path template are path params, the `body` property is
 * the JSON request body, everything else is a query param.
 *
 * Isomorphic on purpose — imported by the server handler AND the client root.
 */
import type { HostToolDefinition, HostToolParam, ManifestTool } from "@flowlet/core";

const TEMPLATE_PARAM = /\{([^}]+)\}/g;

function pathParamNames(path: string): string[] {
  return [...path.matchAll(TEMPLATE_PARAM)].map((m) => m[1] as string);
}

export function manifestToolsToHostTools(tools: ManifestTool[]): HostToolDefinition[] {
  return tools.map((t) => {
    const properties =
      (t.inputSchema["properties"] as Record<string, unknown> | undefined) ?? {};
    const required = Array.isArray(t.inputSchema["required"])
      ? (t.inputSchema["required"] as string[])
      : [];

    const inPath = new Set(pathParamNames(t.binding.path));
    for (const p of inPath) {
      if (!(p in properties)) {
        throw new Error(
          `tool "${t.name}": path parameter "${p}" is not declared in inputSchema.properties`,
        );
      }
    }

    const params: HostToolParam[] = Object.keys(properties)
      .filter((key) => key !== "body")
      .map((key) => ({
        name: key,
        in: inPath.has(key) ? "path" : "query",
        required: required.includes(key),
      }));

    return {
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: {
        readOnlyHint: !t.annotations.mutating,
        destructiveHint: t.annotations.dangerous,
        // A read is idempotent by construction; a write is only if declared.
        idempotentHint: t.annotations.idempotent ?? !t.annotations.mutating,
        openWorldHint: false,
      },
      http: {
        method: t.binding.method.toLowerCase() as HostToolDefinition["http"]["method"],
        path: t.binding.path,
        params,
        hasBody: "body" in properties,
      },
    };
  });
}
