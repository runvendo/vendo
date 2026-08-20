---
"@vendoai/apps": patch
---

The live-props courier waits its turn on the app row, so a ✦ remix stops failing
to mint. One tap in three died with `app changed under this save`, at the moment
a person first creates a remix.

A save asserts the row is still byte-identical to the baseline it computed over
and refuses otherwise, because a document computed over a stale row would revert
the edit that landed there. That assertion cannot tell an edit from a write that
is not one — and the courier is not one: it writes `seed.props` whenever the host
re-renders, mints no version, and the `<Remixable>` wrapper starts couriering the
moment discovery finds the freshly minted row, which is squarely inside the
build. Landing inside a save's baseline-read→put window refused that save, and the
mint reported the refusal as a failed build.

The two writers take a turn on the row now, read included, so the courier's write
lands strictly before or strictly after a save and never inside one. The save's
assertion is untouched and stays strict: a genuine concurrent edit is still
refused exactly as before, and a writer that does not come through the door is
still caught. The courier's boundary is untouched too — the allowlist is still
the captured baseline's own declared prop names, applied before anything is
stored.
