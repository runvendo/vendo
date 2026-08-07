---
"@vendoai/ui": patch
---

Two surfaces that stated something untrue, and were believed.

- `DataTable` compared every filter against the RAW field while its cells show
  the formatted value. Picking "paid" from a filter dropdown also listed the
  "unpaid" rows (each column carried `filterFn: "includesString"`, and a
  dropdown is an exact-value control); searching for "$2,500" or "Mar 14" — the
  text on screen — matched nothing; and the dropdown offered "2026-03-14" as an
  option for a column reading "Mar 14, 2026". One helper, `displayText`, is now
  what the options, the dropdown match (exact) and the search all compare
  against. Sorting still keys off the raw value.
- The Share dialog never read the `error` its own hook exposes, so a failed
  app-access read rendered the empty initial data as fact — twice, and
  self-contradicting: "You don’t have access to this app." next to "Nobody else
  yet — it’s just you." It now says the read failed, offers a retry, and
  withholds the write controls it has no basis to offer.
