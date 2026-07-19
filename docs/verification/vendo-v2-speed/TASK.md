# LANE: generation SPEED — instrument, then land the near-term wins (branch yousefh409/vendo-v2-speed, off main)

RESUMABLE: commit each step + each measurement the instant you have it; resume from git log + README.

## Goal
v2's bar is <1s first paint / <10s complete. The genui-bench work established: the wall is hidden model DELIBERATION (~16s p50 thinking), not prompt size or queue/prefill. Owned serving (sub-second) is OUT OF SCOPE. This lane lands the near-term, BYO-API wins and PROVES them with real before/after numbers.

## Step 1 — INSTRUMENT first (do not optimize blind)
Add lightweight timing around the real create path in packages/apps (engine.ts `modelEngine.create` + runtime): capture (a) time to tier-0 first paint (onPartial first emit), (b) time to full-quality complete, (c) whether extended thinking was on, (d) token counts. Emit as structured timing (behind a debug flag / telemetry seam already in @vendoai/telemetry if one fits). Write a small repeatable measurement harness (a script or a live test) that runs a fixed prompt against a demo host catalog N times and reports p50/p90 for paint + complete. Commit the BASELINE numbers to docs/verification/vendo-v2-speed/README.md BEFORE changing anything.

## Step 2 — land the wins (each behind a measurement; keep clean/minimal)
1. **Skip the agent/tool loop for plain creates.** A plain "build an app" create should not pay for tool-use round-trips it doesn't need. Confirm whether create currently runs an agentic/tool loop; if so, gate it so simple creates go straight to a single wire generation. Measure the delta.
2. **Make the tier-0 paint lane truly no-think + warm.** The paint lane should run with extended thinking OFF (there's a no-think switch / `deps.paint` seam — engine.ts create ~966). Ensure it's actually no-think and as small/fast as possible (target ~3s, from ~10s). Measure.
3. **Prewarm on page-open.** Add a prewarm path so the surface can fire a warm/no-op generation request when it mounts (or warm the model connection / cache), so the first real create isn't cold. Wire a minimal endpoint/hook; measure cold-vs-warm first-paint.

Do NOT touch the generation-quality validation/prompt sections that other lanes own (prewired props, projection, island/action) — stay in the create-orchestration + paint-lane + prewarm regions of engine.ts, plus new files. Rebase onto main before merge.

Gate stays green: `pnpm install` then `pnpm build && pnpm test && pnpm typecheck && pnpm lint`.

## Step 3 — RE-MEASURE + report
Re-run the same harness; commit before/after p50/p90 for first paint + complete to README. Be honest: if a win doesn't move the number, say so and keep or drop it on merit. Note remaining gap to <1s/<10s and that it needs owned serving (out of scope).

Measurement can be mostly headless (live engine against a host catalog) — you do NOT need the full browser matrix, but do a single real-browser sanity check that paint still renders and the upgrade swaps in place (screenshot to docs/verification/vendo-v2-speed/). PRODUCTION boot only if you boot a host (never `next dev`, 40GB OOM). Keys in /Users/yousefh/orca/workspaces/flowlet/.env → gitignored, never commit.

## Done
Summary in README with the before/after table. PR to main, self-triage AI reviewers, merge if CI green. Worktree comment "SPEED: paint <x>s→<y>s, complete <a>s→<b>s". If blocked, commit + say BLOCKED.
