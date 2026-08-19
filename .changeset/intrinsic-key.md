---
"@vendoai/apps": patch
---

A screen may write `key` on a display brick again. The screen typings declared
`key` once, on `JSX.IntrinsicAttributes` — but TypeScript intersects that into a
value-based element only, never into an intrinsic tag, which takes
`JSX.IntrinsicElements[tag]` verbatim. So `<Card key={id}>` compiled and
`<li key={id}>` was a hard TS2322, while the format skill was telling the model
to write `key={…}` on every row it maps: the product demanded exactly what its
own checker refused. The refusal was unreadable on top of being wrong — a
whole-attribute error attributed to the first attribute printed `prop "key" on
<li> takes string | number, but this value is string`, so a model repairing the
screen flipped `key={i}` and `key={String(i)}` until it ran out of rounds. The
display bricks now carry `key` in their own props type, beside `children` and
`style`.
