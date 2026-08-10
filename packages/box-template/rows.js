/**
 * Durable rows — the app's own data, in the Vendo store.
 *
 * Rows are automatically scoped to the END USER. The app never names an owner,
 * cannot set one, and cannot see another user's rows: the host stamps every row
 * with the subject of $VENDO_APP_TOKEN, which is why there is no owner argument
 * anywhere below. Durable data goes here; the disk is scratch.
 *
 * The app's SERVER half only — this reads $VENDO_APP_TOKEN, and fns.js is the
 * only place that may. The page reaches rows through an fn, with `callFn`
 * (src/fn.ts).
 *
 *   import { rows } from "./rows.js";
 *   const notes = rows("notes");
 *   await notes.put("note_1", { title: "Hello" });   // → the stored record
 *   await notes.get("note_1");                       // → the record, or null
 *   await notes.list({ limit: 20 });                 // → { records, cursor? }
 *   await notes.delete("note_1");
 */

/** Read at CALL time, never at import: the supervisor injects the boundary env
 *  into the app process, and this module may be imported on either side of it. */
const boundary = () => {
  const url = process.env.VENDO_STORE_URL;
  const token = process.env.VENDO_APP_TOKEN;
  if (!url || !token) {
    const missing = !url ? "VENDO_STORE_URL" : "VENDO_APP_TOKEN";
    throw new Error(
      `rows() cannot reach the Vendo store: ${missing} is not set. `
      + "The supervisor puts it in the app process's environment, so this code is running outside it. "
      + `Start the app through its .vendo/run line (\`node server.js\`), or set ${missing} yourself when running it by hand.`,
    );
  }
  return { url: url.replace(/\/+$/, ""), token };
};

/** One store call. A failure throws an Error carrying `.code` and `.status` as
 *  own properties, so a caller branches on `error.code === "conflict"` rather
 *  than parsing the message. */
const call = async (method, path, init = {}) => {
  const { url, token } = boundary();
  const response = await fetch(`${url}/rows/${path}`, {
    ...init,
    method,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
  const body = await response.json().catch(() => undefined);
  if (response.ok) return body;
  // Anything that is not the store's {error:{code,message}} envelope — a proxy's
  // HTML, a truncated body — still has to arrive as a coded error.
  const code = body?.error?.code ?? "machine";
  const message = body?.error?.message ?? `the store answered ${response.status}`;
  return Promise.reject(Object.assign(new Error(`${code}: ${message}`), { code, status: response.status }));
};

/** The four verbs over one collection: `rows("notes").put("note_1", {...})`. */
export const rows = (collection) => ({
  /** `{ records, cursor? }`. query: `{ refs?, limit?, cursor? }`. There is no
   *  owner filter — the host refuses `refs.subject`, because every row you can
   *  list is already this user's. */
  async list(query = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query.refs ?? {})) params.set(`refs.${key}`, value);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    const search = params.toString();
    return call("GET", `${collection}${search === "" ? "" : `?${search}`}`);
  },

  /** The record, or `null` when there is none: a missing row is not an error
   *  for a get, so the easy path stays the correct one. */
  async get(id) {
    return call("GET", `${collection}/${encodeURIComponent(id)}`).catch((error) => {
      if (error.code === "not-found") return null;
      throw error;
    });
  },

  /** Writes the row and returns the stored record. `data` is the payload
   *  itself; `options.refs` are optional string tags `list` can filter on. */
  async put(id, data, options = {}) {
    return call("PUT", `${collection}/${encodeURIComponent(id)}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data, ...(options.refs === undefined ? {} : { refs: options.refs }) }),
    });
  },

  /** Removes the row. */
  async delete(id) {
    await call("DELETE", `${collection}/${encodeURIComponent(id)}`);
  },
});
