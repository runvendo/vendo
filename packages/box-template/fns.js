/**
 * The app's POST /fn/<name> handlers: name → async (args) => result.
 * A handler's return value becomes the {result} envelope; a throw becomes
 * {error:{code:"machine"}}. Durable data goes through the Vendo store
 * ($VENDO_STORE_URL + $VENDO_APP_TOKEN), not the disk.
 *
 * This is the app's SERVER half: it runs in the box, holds the app's own token,
 * and is the only place that may. The page calls it with `callFn` (src/fn.ts).
 */
export const fns = {
  // example: async listItems() { return { items: [] }; },
};
