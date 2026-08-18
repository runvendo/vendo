---
"@vendoai/apps": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

Screens are natural JavaScript now. Reads take inputs and resolve through a
supply loop that keeps the screen's state alive; per-row and plain slots take
real closures; the `field=`/`semantic:` dialect, the slot law, the nesting
whitelist and both auto-repair regexes are deleted. The sealed VM borrows the
host's Intl, so money, dates, durations and "2 hours ago" print what a browser
prints, pinned to the host's locale and zone. The Kit's surface answers the
ecosystem's conventions — `value=`, `name`/`header`/children accepted, column
`width`/`truncate`/`priority`, human durations, `grow`, icon/loading buttons,
option groups — and twenty silent misbehaviors now speak up or behave. The
screen agent's brief sheds the rules whose reasons died, gains worked examples,
and tells the truth about the frame: everything the ask names must be visible.

Breaking: the value-formatting tier is deleted — `Money`, `Percent`, `Num`,
`DateTime` and the container `format` tokens are gone; screens format with the
host-bridged Intl in their own code (chart axes keep a format token, the one
place a value never passes through screen code). Also: `field=`,
`semantic:`, `Percent whole` and the `percent` format token are gone — divide
and scale where you prepare the data; slots accept elements or functions.
