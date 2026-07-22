/** Portability-gate fixture: the exact wiring shape a Cloudflare Worker host
 *  uses — createVendo at MODULE SCOPE (where Workers forbids I/O, timers, and
 *  randomness), a stub store/model so the fixture needs no credentials, and
 *  the wire handler exported as the fetch entry. If construction regresses to
 *  eager work, workerd refuses to instantiate this module and the gate fails
 *  before any request is served. */
import { createVendo } from "@vendoai/vendo/server";

/** Callable-anything proxy: every property is a callable that resolves to
 *  undefined, so composition-time store binding (records(), blobs(), ...)
 *  succeeds without a database. The /status probe never reads data. */
const anything = new Proxy(function anything() {}, {
  get(_target, property) {
    if (property === Symbol.toPrimitive || property === "then") return undefined;
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
  principal: async () => null,
  model: stubModel,
  store: stubStore,
});

export default {
  fetch(request) {
    return vendo.handler(request);
  },
};
