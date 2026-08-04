# Gate logs — the convention

Checklist 12 (conductor ruling 7 + 17b). A wave that says "all four gates green"
and leaves no artifact is unanswerable afterwards: nobody can tell which targets
actually ran and which came back `FULL TURBO` from a cache another worktree
populated. So every gate run that a round reports lands here, verbatim, with the
command line that produced it.

**The rule: forced, serial, and the `Cached:` line stays in the log.** A turbo
summary reading `Cached: 0 cached, N total` is the proof the work ran; anything
else is a cache replay and does not count as a gate.

## The FINAL integration run (`redesign/ui-s1` @ `595d3b864`)

These four logs are the wave's gate of record: the merged tree, after all three
post-check rounds and the three cross-round commits. Run from the repo root, in
this order, one after another:

```
pnpm build --force
pnpm exec turbo run test test:ui --force --concurrency=1 --continue
pnpm typecheck --force
pnpm exec turbo run lint --force
```

`pnpm exec turbo` rather than bare `turbo` — turbo is not on PATH in a
non-interactive shell. `--concurrency=1` for the test target, because that is the
one whose failures are otherwise indistinguishable from machine contention.
`--continue` is new and deliberate: without it turbo stops scheduling at the first
failing task, and the first attempt reported `23 successful, 30 total` — hiding 26
tasks behind one failure and making attribution impossible.

| log | target | forced | result |
| --- | --- | --- | --- |
| `build.log` | `pnpm build --force` | yes | 24 successful / 24 · `Cached: 0 cached, 24 total` · 1m25.2s · `EXIT=0` |
| `test.log` | `…turbo run test test:ui --force --concurrency=1 --continue` | yes | **56 successful / 56** · `Cached: 0 cached, 56 total` · 16m3.6s · `EXIT=0` |
| `typecheck.log` | `pnpm typecheck --force` | yes | 43 successful / 43 · `Cached: 0 cached, 43 total` · 29.3s · `EXIT=0` |
| `lint.log` | `pnpm exec turbo run lint --force` | yes | 6 successful / 6 · `Cached: 0 cached, 6 total` · 3.9s · `EXIT=0` |

All four forced, nothing replayed from cache. Inside `test.log`: `@vendoai/ui`
vitest **100 files / 925 tests passed**, and the browser smoke pack
(`@vendoai/ui:test:ui`) **11 passed** in 25.8s — 11, not 10-and-a-skip, because
this integration deleted the `test.fixme` that had quarantined the §15 no-Retry
assertion.

Each log opens with the UTC timestamp, the branch tip it ran against, and the
exact argv, and ends with `EXIT=<code>` — the shell's own answer, not a claim.

### Three things this run had to fix about the gate itself

Worth writing down, because each one made an earlier gate a lie:

1. **`EXIT=` was always 0.** The runner did `"$@"; echo; echo "EXIT=$?"` — the
   bare `echo` in between clobbered `$?`, so every log claimed success including
   one whose target had failed. `$?` is now read into a variable on the very next
   line.
2. **The quiescence wait deadlocked on itself.** The runner waited on
   `pgrep -f "test-health"` for a foreign suite to clear; the watcher processes'
   own command lines contained that string, so it matched itself and waited
   forever.
3. **The gate poisoned its own test target.** These logs are TRACKED files (the
   ruling-17b convention force-adds them), and writing a ~1 MB `test.log` in place
   pushed `git diff` past 1 MB mid-run — while `genui-bench`'s
   `readGitStateFromCli` snapshots `git diff` through `execFileSync` with Node's
   default 1 MB `maxBuffer`. It died with `spawnSync git ENOBUFS` inside the very
   gate that was writing the log. Confirmed by measurement (`git diff` =
   1,727,769 bytes) and by `genui-bench` passing 122/122 the moment the worktree
   was clean. The runner now writes to `/tmp` and copies the logs in afterwards.
   A latent robustness bug in `genui-bench` (an unbounded `git diff`) is left
   alone as out of scope, and noted for the PR.

### Machine conditions, stated

The final run was NOT on a quiet laptop: two other sessions were running their own
forced suites (`/private/tmp/test-health`, `flowlet/harness-work`). Every run uses
`--force`, so no verdict here is a cache replay and the result is not
contaminated — but the timings are inflated and are not comparable to round C's.
The one contention-shaped failure this exposed was real and is fixed: two of round
C's five `approvals-feed` assertions measured poll ticks inside a fixed 250 ms
real-time window, which is a coin flip under load (the same window gave 3 polls
once and 7 the next). They now assert on elapsed time and on a drained window
instead — strictly stronger, and proven to still fail on the defect they exist to
catch.
