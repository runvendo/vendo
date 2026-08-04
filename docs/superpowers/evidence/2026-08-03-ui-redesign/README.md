# UI redesign wave — evidence index

Every folder in this tree, what it proves, and how it was proved. Read this
before any individual folder: several were captured against surfaces that have
since changed, and each one says so below rather than in a footnote you have to
go find.

**Where the surfaces were served.** This whole wave ran LOCALLY — a laptop, a
`demo-bank` dev server, and the `packages/ui` vite harness on ephemeral ports.
Nothing was deployed to a fleet machine, so there are no preview URLs anywhere
in this tree and none should be claimed. Reproducing any of it means running the
capture script in the folder against a local server; the port each one used is
recorded in its own README.

## Build lanes

| Folder | What it proves | Surface + method |
|---|---|---|
| `lane-a/` | S1 foundation — the token/CSS layer, with a before/after for every change | headless Chromium against `demo-bank` (Maple) on `:3210` **and** the `packages/ui` e2e harness on `:4271`; every `before-*` is the identical script against the pre-change `chrome-css.ts` |
| `lane-b/` | the card shell | headless Chromium (Playwright 1.61) against the harness on `:4272`, real wire fixture, real components; videos → GIF via ffmpeg |
| `lane-b2/` | card polish — **supersedes lane-b's captures** | same harness. Lane B's evidence was captured on a page whose own debug element printed `resolved: {"approve":true}`, so it read exactly like the defect the wave was killing, and it never showed a card SETTLING. Nothing in b2 contains that element |
| `lane-c/` | the transcript shows the work (beats, folding, the settled row) | headless Chromium against the SHIPPED `VendoThread`, driven by the shipped director mode (`ScriptedTransport`). Only the SOURCE of the part stream is scripted |
| `lane-d/` | background attention (§2 G1, §3 H1, §4 N1) | headless Chromium, real `@vendoai/ui` chrome on a Maple-themed host page, `ScriptedTransport` for a deterministic multi-step turn. **Limit stated in-folder: generation was broken on this branch when captured** |
| `lane-e/` | the generation seam + a live brain probe | node probes and gate tails, not screenshots. Includes the generation-failure diagnosis |
| `lane-f/` | desktop + mobile walkthrough stills (20 PNGs) | headless Chromium. **No README** — the filenames are the whole record |
| `lane-g/` | the cards set | screenshots only, under `lane-g/cards/`. **No README** |

## Fix rounds

| Folder | What it proves | Surface + method |
|---|---|---|
| `fix-defects/` | the two build states the wave E2E photographed wrong, re-captured after the fix | same surface and method as `integration/` |
| `fix-leaks/` | the last four consumer-voice / honesty leaks (§16 law 3, honest money) | branch `redesign/fix-voice-leaks` off `redesign/ui-s1` |
| `fix-quota/` | two honesty defects found by the wave E2E, not by a test — what a person reads when a build fails | branch `redesign/fix-quota-lie` off `redesign/ui-s1` @ `c94ce0ac6` |
| `pass3/` | the last three consumer-voice holes (conductor ruling 11) | real browser, branch `redesign/ui-s1` base `c0f4b98ac` |
| `final-cleanup/` | the run-history row icon, and Cadence's last model essay | branch `redesign/final-cleanup` off `redesign/ui-s1` @ `551b52727` |

## Integration E2E

| Folder | What it proves | Surface + method |
|---|---|---|
| `integration/` | the WAVE E2E (plan I2) — one continuous run as a real user | **live** `demo-bank`: real Maple login, real `ANTHROPIC_API_KEY` → `claude-sonnet-4-6`, real generation, real guarded host tools, headless Chromium, recorded end to end. **Superseded** — `wave.gif` records behaviour that no longer ships |
| `integration-v2/` | the wave E2E RE-CAPTURED after the three post-check rounds; 24 numbered claims, each with a machine-read fact | same live method. **Two segments are faulted rather than live, and say so in-folder**: frame `13`'s dead turn is a network-layer abort (the cause is injected, the surface reacting is the shipped one), and frame `17`'s ✕ comes from a deterministic refusal |

## Post-check rounds

| Folder | What it proves | Surface + method |
|---|---|---|
| `postcheck-a/` | honesty / voice / logic — six findings, one screenshot each | real Chromium (Playwright 1.61, deviceScaleFactor 2) against the harness **built in production mode**, served by `vite preview` on `:3226` |
| `postcheck-b/` | a11y / motion / center — sixteen checker findings, plus axe before/after at desktop and 390px | real Chromium on `:3227`. **Its two proof specs (`center.proof.spec.ts`, `shots.proof.spec.ts`) were one-shot runs outside `playwright.config.ts`'s `testDir`** — their durable half is now `packages/ui/e2e/center-a11y.spec.ts` and runs in CI |
| `postcheck-c/` | performance and making the gate real — H15, H16, checklist 11, checklist 12 | includes a 60s `/approvals` request trace BEFORE and AFTER the shared feed |
| `postcheck2-gate/` | **this round** — making the gate honest and the smoke tests discriminating; see below |
| `gates/` | the gate logs of record for each round: which targets ran, forced or cached, and their exit codes | written by `scripts/serial-gate.sh`. A `VERDICT` file names the stamp and commit each set of logs covers |

## `postcheck2-gate/` — this round

Each file is a reverting proof: the test, run twice, with the fix removed and
then restored.

| File | What it shows |
|---|---|
| `proof-1-m19-REVERTED.txt` / `-RESTORED.txt` | the §8 smoke test now fails when the M19 CSS suppression is deleted (`+ "fl-caret", "fl-skeleton-bar", "p::after", "table::after"`), and passes when it is back |
| `proof-2-poller-UNSHARED.txt` / `-RESTORED.txt` | the H15 request count reads 4 on mount with one feed per hook instance, 1 with the shared feed |
| `approvals-poller-trace.txt` | the 60-second trace: 13 requests for three surfaces (three pollers would be ~39) |
| `proof-4-runner-atomicity.txt` / `.sh` | the gate runner's four behaviours — all-green, one red, a torn STATUS, and an abort mid-target — with instant stand-in targets. Re-runnable: `zsh proof-4-runner-atomicity.sh <path-to>/scripts/serial-gate.sh` |
| `proof-5-enobufs-REVERTED.txt` / `-RESTORED.txt` | `readGitStateFromCli` throws `spawnSync git ENOBUFS` on a 3 MB tracked diff with Node's default buffer, and survives with 64 MB |
| `proof-6-center-a11y-REVERTED.txt` / `-RESTORED.txt` | removing H16's viewport gate and H11's `inert` turns three `center-a11y` tests red |
| `proof-7-production-harness.md` | the measurement that corrects the checker: `developmentMode()` was already off in BOTH harness modes, so the two red assertions were stale, not dev-mode artefacts; full-suite dev vs production is identical |
| `gate-*.txt` | this round's real gate runs — the green run of record and the deliberate failure-path demonstration |

The honest per-test coverage table for the browser suite lives beside the specs,
at `packages/ui/e2e/README.md`, not here.
