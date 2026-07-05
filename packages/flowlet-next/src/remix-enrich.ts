/**
 * Server-side anchor-source enrichment (remix-fidelity epic, 2026-07-04).
 *
 * The client never supplies `scoped.source` — any client value is STRIPPED
 * before enrichment so the field's provenance stays unambiguous. Sources come
 * from, in precedence order: the `remixSources` handler option (map or
 * resolver; `undefined` falls through), then the `.flowlet/remix-sources.json`
 * capture — re-read live from disk in dev so an edited component is never a
 * stale baseline (production never touches the filesystem at request time).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  FlowletUIMessage,
  RemixSourceRecord,
  RemixSourceResolver,
} from "@flowlet/core";

/** Same cap as capture; the engine also caps as last defense. */
export const SOURCE_CAP_BYTES = 48 * 1024;

export function capSource(source: string): string {
  return source.length > SOURCE_CAP_BYTES
    ? `${source.slice(0, SOURCE_CAP_BYTES)}\n[truncated]`
    : source;
}

export interface SourceResolverConfig {
  option?: Record<string, string> | RemixSourceResolver;
  captured: Record<string, RemixSourceRecord>;
  /** Injectable for tests. */
  env?: Record<string, string | undefined>;
  readFile?: (file: string) => string;
  cwd?: string;
}

export function createSourceResolver(config: SourceResolverConfig): RemixSourceResolver {
  const env = config.env ?? process.env;
  const read = config.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  const cwd = config.cwd ?? process.cwd();
  return (anchorId) => {
    const option = config.option;
    if (typeof option === "function") {
      const resolved = option(anchorId);
      if (resolved !== undefined) return capSource(resolved);
    } else if (option && anchorId in option) {
      return capSource(option[anchorId]!);
    }
    const record = config.captured[anchorId];
    if (!record) return undefined;
    if (env["NODE_ENV"] !== "production") {
      // Bound the read to the project root — a captured `file` must never
      // escape it via `../` traversal (Codex review). On any breach or read
      // failure, fall back to the captured copy.
      const root = path.resolve(cwd);
      const target = path.resolve(root, record.file);
      const rel = path.relative(root, target);
      const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
      if (inside) {
        try {
          return capSource(read(target));
        } catch {
          /* file moved/deleted since capture — fall back to the captured copy */
        }
      }
    }
    return capSource(record.source);
  };
}

/**
 * Strip any client-supplied `scoped.source` from EVERY message, then enrich
 * the LAST user message's scoped anchor from the resolver. Pure; returns a
 * new array (originals untouched).
 */
export function enrichAnchorSources(
  messages: FlowletUIMessage[],
  resolve: RemixSourceResolver,
): FlowletUIMessage[] {
  const lastUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") return i;
    }
    return -1;
  })();

  return messages.map((message, index) => {
    const scoped = message.metadata?.anchors?.scoped;
    if (!scoped) return message;
    const { source: _clientSupplied, ...rest } = scoped;
    const enriched =
      index === lastUserIndex ? resolve(rest.anchorId) : undefined;
    return {
      ...message,
      metadata: {
        ...message.metadata,
        anchors: {
          ...message.metadata!.anchors,
          scoped: { ...rest, ...(enriched !== undefined ? { source: enriched } : {}) },
        },
      },
    };
  });
}
