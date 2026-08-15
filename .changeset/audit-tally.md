---
"@vendoai/core": minor
"@vendoai/store": minor
---

`audit.tally` — the 45th store op, and the grouped read a decision tally is.

A reviewer's tally ("how many calls ran, were asked about, were blocked, and by
which layer, hour by hour") is a `GROUP BY`, not a page. Reading it through
`audit.list` means shipping every event in the window across the wire and
counting it at the other end, which is why the console reached around StoreOps
into raw SQL for it. Now it does not have to.

```ts
const rows = await store.ops.audit.tally({
  from: startOfDay,            // inclusive, REQUIRED, and the whole window
  kind: "tool-call",           // the same four filters audit.list narrows on
});
// [{ bucket: "2026-08-14T09:00:00.000Z", outcome: "ok", decidedBy: "grant", count: 12 }, …]
```

- **The same WHERE as the feed.** `kind`, `venue`, `outcome` and `decidedBy`,
  ANDed, now named once as `AuditFilters` and shared by both audit reads on the
  contract, on the wire and inside each backend. A tally that narrows
  differently from the feed it sits next to is a number nobody can reconcile.
- **`from` is required and there is no `to`.** A tally has no cursor, so the
  floor is the only thing bounding the answer, and a caller who cannot leave it
  out cannot ask a mount to group an append-only drawer's whole history. Every
  tally is "since"; an upper bound is grammar no consumer has asked for and stays
  addable later.
- **Fixed UTC-hour buckets, no bucket grammar.** `bucket` is the instant the
  hour starts rather than an hour-of-day number, because a number only
  identifies a bucket inside one day and the window is whatever `from` makes it.
  Hours holding nothing are omitted; rows sort by bucket, then outcome, then
  decidedBy, with an absent dimension last.
- **Rows are typed with `AuditEvent`'s own fields.** `outcome` and `decidedBy`
  are the event's enums or `null` — a control event is not a call and has no
  outcome, and null is a group of its own. No second copy of either enum.

Served by the local engine (one `GROUP BY`), by the memory reference, and by the
hosted client, with conformance cases both backends run. `/audit/tally` is
declared LAST in `STORE_WIRE_PATHS`, after `/status`: `ops` is a monotone level
over that order, and appending is the only edit to it that cannot re-date a
number a shipped mount already reports. No pre-send capability constant — a new
path answers its own enveloped 501.
