/**
 * `vendo/server` — everything for the API route: createVendoHandler,
 * createVendoFetchHandler, toNodeHandler, startVendoScheduler,
 * ingestVendoEvent, and the rest of the provider-agnostic server engine.
 *
 * Node-only: this module (and its transitive dependencies) assumes a Node.js
 * runtime. Do not import it from a browser bundle — use `vendo/react` there
 * instead.
 */
export * from "@vendoai/server";
