/**
 * Server-side anchor-source enrichment (remix-fidelity epic, 2026-07-04).
 *
 * The client never supplies `scoped.remixSource` or `scoped.pinBase` — any
 * client value is STRIPPED before enrichment so the fields' provenance stays
 * unambiguous (`scoped.envelope` IS client-supplied, but only the last user
 * message's copy survives, for seal verification in the chat handler). Sources
 * come from, in precedence order: the `remixSources` handler option (map or
 * resolver; `undefined` falls through), then the `.flowlet/remix-sources.json`
 * capture — re-read live from disk in dev so an edited component is never a
 * stale baseline (production never touches the filesystem at request time).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  FlowletUIMessage,
  RemixSourceRecord,
  RemixSourceResolver,
  ResolvedRemixSource,
} from "@flowlet/core";
import type { RemixSealer } from "@flowlet/runtime";

/** Same cap as capture; the engine also caps as last defense. */
export const SOURCE_CAP_BYTES = 48 * 1024;

export function capSource(source: string): string {
  return source.length > SOURCE_CAP_BYTES
    ? `${source.slice(0, SOURCE_CAP_BYTES)}\n[truncated]`
    : source;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Resolve a raw source text into the record the engine consumes. */
function resolved(
  raw: string,
  exportName?: string,
  sourceHash?: string,
  prepared?: string,
): ResolvedRemixSource {
  const capped = capSource(raw);
  return {
    source: capped,
    ...(prepared !== undefined ? { prepared } : {}),
    ...(exportName !== undefined ? { exportName } : {}),
    sourceHash: sourceHash ?? sha256(raw),
    truncated: capped !== raw,
  };
}

export interface SourceResolverConfig {
  /** Host-facing option: raw source text (we own hashing/caps/truncation). */
  option?: Record<string, string> | ((anchorId: string) => string | undefined);
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
      const raw = option(anchorId);
      if (raw !== undefined) return resolved(raw);
    } else if (option && anchorId in option) {
      return resolved(option[anchorId]!);
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
          const fresh = read(target);
          // The sync-prepared baseline is only valid for the EXACT captured
          // content; an edited file falls back to the raw text (the model
          // does the glue, as before preparation existed).
          const freshHash = createHash("sha256").update(fresh, "utf8").digest("hex").slice(0, 16);
          const preparedStillValid = freshHash === record.sourceHash ? record.prepared : undefined;
          return resolved(fresh, record.exportName, undefined, preparedStillValid);
        } catch {
          /* file moved/deleted since capture — fall back to the captured copy */
        }
      }
    }
    return resolved(record.source, record.exportName, record.sourceHash, record.prepared);
  };
}

/**
 * Strip any client-supplied `scoped.remixSource`/`scoped.pinBase` from EVERY
 * message and drop `scoped.envelope` from all but the LAST user message (the
 * one the chat handler verifies), then enrich the last user message's scoped
 * anchor from the resolver. Pure; returns a new array (originals untouched).
 */
/**
 * Convert the last user message's client-supplied `scoped.envelope` into a
 * server-verified `scoped.pinBase` (remix fast-edits spec). The opaque
 * envelope NEVER reaches the engine: verified → replaced by the pin base;
 * invalid/foreign/absent → silently dropped (degrade, never escalate). Runs
 * AFTER `enrichAnchorSources` (which already confines the envelope to the
 * last user message). Pure; returns a new array.
 */
export function applyVerifiedPinBase(
  messages: FlowletUIMessage[],
  sealer: RemixSealer | undefined,
  principalUserId: string,
): FlowletUIMessage[] {
  return messages.map((message) => {
    const scoped = message.metadata?.anchors?.scoped;
    if (!scoped || scoped.envelope === undefined) return message;
    const { envelope, ...rest } = scoped;
    const pinBase = sealer?.verify(envelope, { anchorId: rest.anchorId, principalUserId }) ?? null;
    return {
      ...message,
      metadata: {
        ...message.metadata,
        anchors: {
          ...message.metadata!.anchors,
          scoped: { ...rest, ...(pinBase !== null ? { pinBase } : {}) },
        },
      },
    };
  });
}

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
    const {
      remixSource: _clientSource,
      pinBase: _clientPinBase,
      envelope,
      ...rest
    } = scoped;
    const enriched = index === lastUserIndex ? resolve(rest.anchorId) : undefined;
    const keptEnvelope = index === lastUserIndex ? envelope : undefined;
    return {
      ...message,
      metadata: {
        ...message.metadata,
        anchors: {
          ...message.metadata!.anchors,
          scoped: {
            ...rest,
            ...(enriched !== undefined ? { remixSource: enriched } : {}),
            ...(keptEnvelope !== undefined ? { envelope: keptEnvelope } : {}),
          },
        },
      },
    };
  });
}
