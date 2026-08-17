/** Portability-gate fixture: the exact wiring shape a Cloudflare Worker host
 *  uses — createVendo at MODULE SCOPE (where Workers forbids I/O, timers, and
 *  randomness), a stub store/model so the fixture needs no credentials, and
 *  the wire handler exported as the fetch entry. If construction regresses to
 *  eager work, workerd refuses to instantiate this module and the gate fails
 *  before any request is served. */
import { createVendo } from "@vendoai/vendo/server";

/** Callable-anything proxy: every property is a callable that resolves to
 *  undefined, so composition-time store binding (records(), blobs(), ...)
 *  succeeds without a database.
 *
 *  `list` is the one verb that must answer a real SHAPE rather than undefined.
 *  The boot reconcile lists this deployment's code-authored automations on the
 *  ready() latch — which /status arms — and it does so even with zero `.on()`
 *  declarations, because a deployment that just deleted its last one still has
 *  stragglers to disarm. An empty page is the honest answer for a store with no
 *  database behind it. */
const anything = new Proxy(function anything() {}, {
  get(_target, property) {
    if (property === Symbol.toPrimitive || property === "then") return undefined;
    if (property === "list") return () => Promise.resolve({ records: [] });
    return anything;
  },
  apply() {
    return Promise.resolve(undefined);
  },
});

const stubStore = new Proxy(function stubStore() {}, {
  get(_target, property) {
    if (property === Symbol.toPrimitive || property === "then") return undefined;
    if (property === "ensureSchema" || property === "close") return () => Promise.resolve(undefined);
    if (property === "query") return () => Promise.resolve({ rows: [] });
    return anything;
  },
});

const stubModel = {
  specificationVersion: "v3",
  provider: "gate-stub",
  modelId: "gate-stub",
  supportedUrls: {},
  doGenerate: () => Promise.reject(new Error("gate stub model")),
  doStream: () => Promise.reject(new Error("gate stub model")),
};

const vendo = createVendo({
  // Every request must resolve a principal — a resolver returning null refuses
  // with 403, /status included. The gate probes boot, not identity.
  principal: async () => ({ kind: "user", subject: "gate" }),
  models: { default: stubModel },
  store: stubStore,
});

export default {
  fetch(request) {
    return vendo.handler(request);
  },
};
