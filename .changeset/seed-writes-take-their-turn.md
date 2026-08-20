---
"@vendoai/apps": patch
---

A ✦ remix stops silently reverting the live props the courier just delivered.
The remix would quietly go back to showing the values captured the day
`vendo sync` ran, while the host's own component beside it showed today's — with
nothing refused and nothing logged.

The ✦ door twice read the app row and then put a whole document computed over
that read: putting the mint's name back after the port's paint renamed the app,
and marking a failed build over the row as it stands. Neither read-modify-write
took a turn on the row, so the courier — which writes `seed.props` whenever the
host re-renders, and re-renders all the way through a mint — could land its write
between one of those reads and its put, and the put carried the pre-courier
document straight back over it.

Both now take the same turn on the row every other writer takes, read included,
so the courier's write lands strictly before or strictly after them and never
inside one. The save's assertion is untouched and stays strict: a genuine
concurrent edit is still refused exactly as before. The courier's boundary is
untouched too — the allowlist is still the captured baseline's own declared prop
names, applied before anything is stored.
