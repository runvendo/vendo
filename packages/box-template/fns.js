/**
 * The app's POST /fn/<name> handlers: name → async (args) => result.
 * A handler's return value becomes the {result} envelope; a throw becomes
 * {error:{code:"machine"}}. Durable data goes through the Vendo store, not the
 * disk: reach it with `rows` from ./rows.js.
 *
 * This is the app's SERVER half: it runs in the box, holds the app's own token,
 * and is the only place that may. The page calls it with `callFn` (src/fn.ts).
 */
import { rows } from "./rows.js";

export const fns = {
  // example: async listNotes() { return { notes: (await rows("notes").list()).records }; },
};
