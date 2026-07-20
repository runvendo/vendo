/**
 * The app's POST /fn/<name> handlers: name → async (args) => result.
 * A handler's return value becomes the {result} envelope; a throw becomes
 * {error:{code:"machine"}}. Durable data goes through the Vendo store
 * ($VENDO_STORE_URL + $VENDO_APP_TOKEN), not the disk.
 */
export const fns = {
  // example: async listItems() { return { items: [] }; },
};
