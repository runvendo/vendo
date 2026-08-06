---
"@vendoai/vendo": major
"@vendoai/core": major
"@vendoai/automations": minor
---

**BREAKING:** the pack concept is gone. Capability arrives on `tools` and
`skills`, and app generation and automations mount themselves.

A pack was a labelled bundle of four lists, and every one of those lists already
had a home of its own: tools → the one registry, skills → the workspace mount,
checks → the checking floor, components → the catalog. The label bought a noun,
a `definePack` handle, a provider function shape, a client-side second import,
and a default list — and nothing else. A developer should never have to learn
it; they already know "tools" and "skills".

- `createVendo({ packs })` is removed. `tools:` now takes executable
  `ToolDefinition` entries alongside the `vendo sync` declarations it already
  took (told apart by `execute`), and `skills:` is new — SKILL.md values mounted
  at `/host/skills`. Checks keep arriving through `apps.checks` and components
  through `catalog`, exactly as a host already writes them.
- `definePack`, `PackProvider` and `Pack` are removed; `PackSkill` is renamed
  `Skill` and kept as a deprecated alias for one release. `<VendoRoot packs>` is
  removed — components were always passable through `components` directly.
- The boot-time collision check survives verbatim in the composition merge: two
  contributors claiming one tool or skill name is still an error at boot that
  names both, and a contributor claiming one of the host's own extracted tool
  names still refuses to compose.
- New: `apps: false` unmounts app generation (`vendo_make`, the `vendo_apps_*`
  tools, the `building-apps` skill and the `/apps` wire surface are absent, not
  refusing), and `automations: false` unmounts automations (`/automations`,
  `/runs` and `/webhooks` answer not-found, `vendo.emit` refuses, nothing fires,
  and THE LAW's unattended-irreversibility rule leaves the reviewer's rubric).
  Both mount by default.
- `@vendoai/automations` now exports `UNATTENDED_IRREVERSIBILITY_RULE` and
  `unattendedIrreversibilityCheck` — the rule moved to the block whose law it is.
  It joins the reviewer's rubric by default now that it rides the subsystem
  rather than an opt-in pack.

A default `createVendo()` composes exactly the tool set and skill set it did
before, asserted against literal lists in `default-composition.test.ts`.
