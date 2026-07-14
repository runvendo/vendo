# gen-verify: corpus screenshot harness + demo GIF tooling (ENG-243)

**Spec:** `docs/superpowers/specs/2026-07-14-ui-generation-design.md` (Workstream 4). All decisions locked by Yousef 2026-07-14.

**Goal:** The measurement and sign-off arm of the ui-generation project. Boot the live-verified corpus repos with Vendo integrated, drive standard generation prompts, capture screenshots/GIFs/timings into a reviewable gallery. Yousef's per-repo visual sign-off on the gallery is the project gate. Also owns the four required demo GIFs.

**Approach:** Extend the existing corpus harness (`corpus/harness`) — reuse clone → inject → bootstrap → boot → e2e-prep and the Layer-3 Playwright driver that already runs real-LLM conversations against booted hosts. Add a capture layer on top rather than building anything new from scratch. Demo-host (Maple/Cadence) capture is a separate small tool under `bench/` since it drives our own demo apps, not corpus clones.

## Repos

Live-verified today: umami, skateshop, papermark (external, 5/5 Layer-3 live) + express-host (deep, local). That is 4; the spec gate says 5. Fifth repo choice escalated to the parent orchestrator — candidate: promote one broad-tier repo (taxonomy or invoify, both batch-A dev-set members) to deep/bootable. The harness takes the repo list as an argument, so this does not block the build.

## Waves

### Wave 1 — gallery capture command (build now)

New harness command: `pnpm corpus gallery [repo...]`. Per repo:

- Boot via existing machinery (including per-repo e2e prep: auth shims, seeds, REST facades).
- Capture the host's own native screens first (the side-by-side baseline).
- Drive a standard set of UI-generating prompts (new per-repo `gallery.json` next to the existing `conversations.json`; reuse existing conversations where they generate UI).
- Record per prompt: video of the full generation (converted to GIF), screenshot at first generated paint, screenshot at settled/usable, and timing marks (generation tool call → first paint → usable) so every wave re-measures the latency bars automatically.
- Emit per-repo artifacts under a gitignored run directory plus one self-contained HTML gallery report (host screen vs generated UI side-by-side, timings, GIFs inline) — the artifact Yousef reviews for sign-off.

Constraints: no `packages/` engine/ui changes (findings go to the parent); harness unit tests per existing conventions; keys sourced from the flowlet `.env`, never committed; artifacts never committed.

### Wave 2 — demo-host GIF tooling (parallel with wave 1)

Capture tool under `bench/` that boots Maple (`demo-bank`) and Cadence (`demo-accounting`) and records the four required beats:

1. Streaming first-paint on Maple AND Cadence with a visible on-page timer overlay proving <1s paint / <10s usable.
2. Host-component beat (model composes host catalog components, e.g. MapleSparkline).
3. Remix/edit beat with no blank-iframe regressions.
4. Corpus montage — an assembly step that composes wave-1 gallery artifacts into a 5-repos-side-by-side GIF with real host screens.

Tooling lands now; the final GIFs are recaptured from real runs after the other streams land (today's runs are baseline material only).

### Wave 3 — baseline run (immediately after wave 1)

Run the gallery on the 4 live repos + Maple/Cadence beats against today's generation (slow, off-brand — that's the point). Record as the 2026-07-14 baseline alongside the parent's measured numbers (first pixel 63–103s, emoji + saturated-palette tells). Send gallery to Yousef/parent as baseline, explicitly not for sign-off.

### Wave 4 — measurement waves (ongoing)

Re-run the gallery as ENG-240 (streaming), ENG-241 (catalog), ENG-242 (fidelity) merge. Report deltas (timings + visual) to the parent after each wave.

### Wave 5 — the gate (last)

Final run on all 5 repos, final recapture of the four demo GIFs from real runs, gallery to Yousef for per-repo sign-off. Done = 4 GIFs + 5/5 sign-offs.

## Execution

codex sol workers execute (Opus 4.8 only if sol usage-blocked); one worker per wave-1/wave-2 track, dispatched via Orca orchestration from this session. Branch `yousefh409/gen-verify`; PR gate: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green.
