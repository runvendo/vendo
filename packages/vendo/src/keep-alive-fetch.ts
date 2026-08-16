/** The default `fetch` for the Vendo Cloud adapters: the platform's own fetch
 *  over a connection pool that holds an idle socket open for a minute.
 *
 *  Node's stock dispatcher drops an idle keep-alive socket after ~4s — shorter
 *  than the gap between two of an agent's tool calls — so nearly every Cloud
 *  round trip paid a fresh TCP+TLS handshake. Measured against
 *  console.vendo.run: 5/5 reconnects across a 6s idle gap on the stock
 *  dispatcher, 0/5 with this pool, worth ~60-90ms of the ~360ms an
 *  after-idle store read used to cost.
 *
 *  Node-only BY CONSTRUCTION, the same posture as deployment-identity.ts:
 *  undici arrives through a dynamic import, so an edge/Worker target that
 *  cannot load it keeps today's plain fetch rather than failing at module
 *  load. And this is only ever what an `options.fetch ?? …` seam falls back to
 *  — a host that brings its own fetch still wins (adapter rule).
 *
 *  Bundlers must never follow the import: webpack resolves dynamic imports
 *  statically, and Next 14's parser cannot read undici 7's syntax, so a Next
 *  14 host's wire route failed to COMPILE (GitHub #1369). The webpackIgnore
 *  comment leaves the import to the runtime — Node resolves undici normally,
 *  and every target that can't gets the same catch-to-plain-fetch as before.
 *  (Turbopack ignores the comment but parses undici fine.) */
import { defaultFetch } from "@vendoai/core";
import type { Agent } from "undici";

/** Long enough to span the gaps between the tool calls of one turn; short
 *  enough that an idle agent is not holding a socket open indefinitely. */
const KEEP_ALIVE_MS = 60_000;

/** A PROMISE, and one per module rather than one per call (apps' `edgeVariant`
 *  shape): every Cloud adapter in the process shares this pool, which is what
 *  lets a connection outlive the adapter that opened it. Resolves to undefined
 *  wherever undici cannot be loaded. */
let pool: Promise<Agent | undefined> | undefined;

const keepAlivePool = (): Promise<Agent | undefined> =>
  pool ??= import(/* webpackIgnore: true */ "undici")
    .then(({ Agent }) => new Agent({ keepAliveTimeout: KEEP_ALIVE_MS, keepAliveMaxTimeout: KEEP_ALIVE_MS }))
    // One catch for BOTH halves on purpose: a Worker target can fail to load
    // undici at all, and a Worker target that a bundler DID hand a copy of it
    // can still fail to construct one. Either way the answer is the same —
    // no pool, plain fetch, today's behavior.
    .catch(() => undefined);

export const keepAliveFetch: typeof fetch = async (input, init) => {
  const dispatcher = await keepAlivePool();
  return dispatcher === undefined
    ? defaultFetch(input, init)
    : defaultFetch(input, { ...init, dispatcher } as RequestInit);
};
