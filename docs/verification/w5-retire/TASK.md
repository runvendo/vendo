# W5a — dialect retirement (branch yousefh409/vendo-w5-retire)

RESUMABLE: commit each step. Authority: spec §Dialect retirement + §Also
(git show origin/yousefh409/format-gen-v2:docs/superpowers/specs/2026-07-19-vendo-v2-general-quality-design.md).
Main now has the FULL v3 build (#412 #414 #415 #417 #425 #432 #433).

## Scope (STAGED retirement — stop teaching, keep compiling; deletion is NOT this lane)
1. **Stop teaching the deprecated dialect**: remove `asOptions`, `template`,
   `currencyCents` format kind, and dotted-column-key guidance from every prompt
   section (engine.ts + generated context) — the Kit's native props
   (labelField/valueField, dot-path columns, format="money", Money/DateTime) are the
   taught path now. Verify nothing in the prompts still recommends the old ops.
2. **Keep compiling**: the reshape ops stay functional for stored apps — mark them
   `@deprecated` in code with a pointer to the Kit equivalents; add a compile INFO
   (not error) when a new create emits one, so usage is observable.
3. **No new reshape ops rule**: add a test asserting the reshape op registry is frozen
   at the current set (a new op addition fails the test with a message quoting the
   spec: "pressure for a new op = a missing Kit prop or an island case").
4. **Prompt spring-clean**: with kitPrompt + semantics + laws + islands all landed,
   sweep the assembled generation prompt once for contradictions/stale guidance
   (e.g. old prewired lists, superseded island rules, <Query>-first teaching — inline
   refs are primary since #425). Fix stale text ONLY — no new rules.
5. Sanity: 2-3 fresh dev prompts live on one prod-booted host — old ops absent from
   output, Kit props used instead. Screenshot, git add -f.

## Done
Gates green. PR to main, self-triage AI reviewers, auto-merge + re-nudge. Worktree
comment "W5a: dialect retired (staged)". Keep it SMALL — the final gate lane runs
right after this merges.
