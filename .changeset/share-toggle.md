---
"@vendoai/apps": minor
"@vendoai/ui": minor
---

The ✦ menu offers one share. `useAppSharing` reads `GET /apps/:id/grants` once —
the caller's level, the app's grants and the caller's own memberships — and
`PinChrome` grows a single "Share with &lt;tenant&gt;" toggle between Update and
Revert. It is absent for a non-owner and for a caller in no tenant, and the
popover stays open when it is switched, because it is a switch rather than a
departure.

Sharing an app with a tenant now MOVES it there first. Every path that creates
an app stamps it with the person, and core refuses a tenant grant on a
still-personal app (ruled 2026-08-01) because the app's documents live under the
holder's own `/user` mount — so `AppsRuntime.access.grant` mints the sharer's own
owner grant, runs `ops.lifecycle.promote`, and only then writes the tenant grant.
The order is load-bearing: the move restamps the row's subject as the org id, so
a sharer who is not a tenant admin would otherwise lose the app she just shared.

Because that move is what makes the grant legal, naming the tenant is now an
authorization claim of its own: `grant` refuses a `team:`/`org:` principal with
`forbidden` unless the caller holds an asserted membership in that org. Owning
the app is not enough — without this an owner could name any org id and have her
app moved into a workspace she does not belong to. Revoking is unchanged, so a
sharer who has since left the tenant can still un-share.
