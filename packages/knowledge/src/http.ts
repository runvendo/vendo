import { VendoError, type KnowledgeAdapter, type KnowledgePosture } from "@vendoai/core";
import { knowledgeWireAdapter } from "./wire.js";

/** BYO defaults: the least a wire endpoint can promise — search + status,
    read-only, attested public-only. Declare more via `posture`. */
const DEFAULT_POSTURE: KnowledgePosture = { fetch: false, write: false, visibility: "public-only" };

export interface HttpKnowledgeOptions {
  /** The endpoint base: the five `vendo/knowledge-wire@1` paths are appended
      directly (`<url>/search`, `<url>/status`, …). */
  url: string;
  auth?: { bearer?: string };
  /** Injectable transport (tests point this at an in-process fake server). */
  fetch?: typeof fetch;
  /** Overrides onto the read-only search-only default — declare exactly what
      the endpoint implements; the conformance suite verifies the claim. */
  posture?: Partial<KnowledgePosture>;
}

/** The BYO template: any host endpoint — any language — implementing the
 * `vendo/knowledge-wire@1` routes is a first-class knowledge engine. Partial
 * implementations are first-class too: a search-only endpoint declares the
 * default posture and the optional adapter members are simply absent (`fetch`
 * missing ⇒ read-more gracefully absent; `write: false` ⇒ `vendo knowledge
 * sync` refuses loudly to push). The reference server implementation lives in
 * this package's `cloud.test-util.ts` fake — one handler, wire-schema-validated. */
export function httpKnowledge(options: HttpKnowledgeOptions): KnowledgeAdapter {
  const base = options.url.replace(/\/+$/, "");
  return knowledgeWireAdapter({
    base,
    ...(options.auth?.bearer === undefined ? {} : { bearer: options.auth.bearer }),
    posture: { ...DEFAULT_POSTURE, ...options.posture },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    errors: {
      unreachable: (cause) => new Error(
        `knowledge endpoint ${base} is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      ),
      badBody: (route) => new VendoError(
        "not-implemented",
        `knowledge endpoint ${base}${route} answered with a body that is not vendo/knowledge-wire@1`,
      ),
    },
  });
}
