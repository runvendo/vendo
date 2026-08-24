---
"@vendoai/apps": minor
---

Built apps do not travel. A sealed bundle is arbitrary code whose only door is the guarded tool bridge, so a copy would run its author's code with the recipient's own permissions — that seam ships with its own consent story. One artifact-kind check, `refuseBundleArtifact`, now refuses `share`, `publish`, `fork`, `exportApp`, `place` and the `access.grant` behind the ✦ share toggle, server-side at the enforcer rather than in the client, with a `blocked` error naming the operation. That grant is the share a person actually performs — `PUT /apps/:id/grants/:principal` never reaches `AppsRuntime.share` — so it is the path the refusal has to hold. Screens are untouched and stay shareable exactly as before.
