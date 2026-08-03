---
"@vendoai/vendo": minor
---

`vendo init` never edits your source, and `vendo sync` owns the whole scan.

**Init stops rewriting `app/layout.tsx`.** The auto-wire that wrapped
`{children}` in `<VendoRoot>` is gone. Every file init writes is new and
Vendo-owned (plus its own `package.json` hooks); mounting the visible surface
is your paste, and the run ends with one framed block naming the exact file and
lines. It also rides `--agent` as a `mount` object and the head of
`manualSteps`, and `vendo doctor`'s `E-WIRE-004` now prints the same paste
instead of describing it.

**One AI rule, one flag pair, on both commands.** `--ai` forces the judgment
pass on and `--no-ai` forces it off, on `init` and `sync` alike. With neither
flag, an interactive run **asks every time** — no consent is persisted anywhere
— and a non-interactive run skips, so CI stays deterministic and never spends.
`--yes` and `--json` count as non-interactive; `--json` still emits exactly one
object and never prompts. `--ai-polish` and `--no-watermark` keep working. The
hooks init installs now carry the flag explicitly (`predev: vendo sync --no-ai`,
`prebuild: vendo sync --strict --no-ai`), and re-running init upgrades the
hookless entries an older init wrote without touching a `vendo sync` call you
wrote yourself.

**Sync re-extracts your theme.** `.vendo/theme.json` was init-only, so a
rebrand never reached the agent. Sync now re-runs the deterministic scan and
reconciles it, using a sibling merge base, `.vendo/theme.extracted.json` (what
the scan produced last time — commit it alongside `theme.json`). A slot is
machine-owned only with recorded proof, so anything you hand-edited — or that
predates the base — is left alone and reported with both values; derived slots
like `accentText` follow their source rather than the app's. `--theme-refresh`
takes your app's values anyway.

**Pin baselines reach Vendo Cloud.** With a key set, a normal sync (no
`--report` needed) reconciles `.vendo/remixable/` with the `vendo_pin_baselines`
collection the console's Remix reviews screen reads — pushing new and changed
slots, deleting slots pruned locally. The captured component **source** crosses
the wire, which is what makes a fork's diff reviewable. Keyless and BYO make no
request at all, and a Cloud failure is a warning, never a failed build.
