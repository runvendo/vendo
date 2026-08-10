---
"@vendoai/apps": minor
"@vendoai/vendo": minor
---

Box rows are owner-stamped, and the box still never learns who the user is.

`PUT $VENDO_STORE_URL/rows/<collection>/<id>` used to land in the generic
records family, where every row an app wrote was one drawer per app and nothing
more. It now lands in the `appData` family, so the door stamps each row with the
subject of the app token that presented it: one user's rows are the only rows
that user's requests can read, list, overwrite or delete. Cross-user access is
unwritable rather than merely forbidden — an id another user holds comes back
`409 conflict`, and a caller who tries to name an owner by sending
`refs.subject` is refused `400 validation`.

Nothing about this crosses the sandbox boundary. The box is told no identity and
takes no owner parameter; the door stamps on its behalf, which is why the client
below has no owner argument to get wrong.

The HTTP contract is unchanged, byte for byte. Existing rows keep their
collection names (`app:<id>:box:<collection>`), and the `appData` backfill gives
rows written before the flip their owner stamp.

**`./rows.js` in the box template** — a zero-dependency client for the door,
which the in-box coding agent is now pointed at first and the raw curl second:

```js
import { rows } from "./rows.js";

const notes = rows("notes");
await notes.put("note_1", { title: "Hello" });  // → the stored record
await notes.get("note_1");                      // → the record, or null
await notes.list({ limit: 20 });                // → { records, cursor? }
await notes.delete("note_1");
```

It is the app's server half only — it reads `$VENDO_APP_TOKEN`, and `fns.js` is
the only place that may. A failure throws an `Error` carrying `.code` and
`.status`, so a caller branches on `error.code === "conflict"` instead of
parsing prose.

A deployment whose store offers neither a SQL handle nor a `StoreOps` surface
now refuses THAT REQUEST on the rows door, naming both ways to give it one,
rather than writing rows nobody owns.
