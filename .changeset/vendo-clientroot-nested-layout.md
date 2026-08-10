---
"@vendoai/vendo": patch
---

`vendo init` and `vendo doctor` find a nested root layout instead of naming a
file that does not exist

An app-router host whose routes all live under an i18n segment or a route group
(`app/[locale]/layout.tsx`, `app/(shop)/layout.tsx`) has no `app/layout.tsx` —
that nested file IS its root layout. Both commands probed for the literal
`app/layout.tsx` and, finding nothing, named it anyway: init printed a paste for
a phantom file, and doctor's E-WIRE-004 demanded the same one. A user who
followed that instruction created a SECOND root layout, which is the one edit
that breaks such a host.

Both now resolve the client root to the shallowest `layout.{tsx,jsx,js}` under
the app directory (lexicographic on a tie), so the paste and the doctor fix name
the file the host actually has. Hosts with a real `app/layout.tsx`, pages-only
hosts (`pages/_app.tsx`), and hosts with no client root at all are unchanged.
