---
"@vendoai/apps": minor
"@vendoai/ui": minor
---

An embed watching a code-first build now paints the app TAKING SHAPE instead of a
bar. `GET /apps/:id/open?pending=1` carries the `tree` it always had room for, and
what fills it is the render the build already made: a code-first build renders its
half-written `app.tsx` on every landed commit to decide whether anything may paint
at all, and that render's SHAPE is now offered to the build-window poll.

Geometry only, through the same whitelist that shipped with the wire field — node
ids, component names and nesting, tagged `streaming`. No props, no resolved data,
no interactive VM, no component sources: a build's draft carries figures its repair
round is about to correct, and nobody may be shown a number the build is about to
change.

The renderer paints that shape node by node. A node the build has not filled in
yet — a name and a place, no props — now holds its own silhouette instead of
nothing, so a screen written from layout and text grows across paints rather than
sitting behind one skeleton until it lands.

Nothing is persisted. No document keeps a tree; the shape lives in the serving
process's memory for the length of the build and nowhere else, so a poll served
before the first paint — or by another process — finds nothing and the embed reads
its beat bar, exactly as it did before.
