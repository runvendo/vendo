---
"@vendoai/vendo": minor
---

A missing `.vendo/policy.json` now says so, at boot and in `vendo doctor`.

A deployment wired the way `vendo init` writes it — `guard: guard({ policy: {} })`
— reads its rules from `.vendo/policy.json`. If that file is not there, the
guard swallows it and keeps serving on its built-in posture. Nothing refused,
nothing logged: the host's own rules simply stopped applying, and the first
sign was an action that should have asked and didn't.

The fallback is deliberate and unchanged — a missing policy file still never
stops a boot. What changes is that it is no longer silent. The boot block gains
a warning row:

```
◆  vendo ready
│  ✓ guard     rules    createVendo({ guard })
│  ⚠ guard     .vendo/policy.json is missing — this deployment's rules are NOT in force.
│              Defaults are in effect: destructive and ungraded actions ask, everything else runs.
│              Restore the file, or pass the rules inline: guard({ policy: { rules: [ … ] } }).
```

and `vendo doctor` gains the static twin, `wiring/policy-file` (E-CFG-001, a
warning — doctor still exits on the same rules it did before).

Both are scoped to a deployment that is actually waiting on that file. Rules
passed inline, a preset name, and a policy config with an explicitly named
`file` all say something different and stay silent — the first two replace the
file outright, and a missing explicit path already throws on its own.
