# Demo Creator Mini Skill (Milestone 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Milestone 4 of the demo-creator spec: the GTM agent on the mac mini can turn "make a demo for <prospect>" into a finished, verified, deployed demo — and nothing reaches a prospect without Yousef's explicit approval.

**Architecture:** A `demo-creator` skill on the mac mini (where the GTM/line agents already run) that: takes prospect name + URL/screenshots + notes, spawns a creator session in an Orca workspace on this repo (following `bench/demo-creator/PLAYBOOK.md`), waits for VERIFIED, optionally runs `demo:deploy`, then iMessages Yousef the demos.vendo.run link + GIF + one-line verification summary and STOPS. Approval to send anything to a prospect is a human step by design; the skill never contacts prospects.

**Decisions:**
- The skill lives with the mini's other skills (same conventions as triage-inbox/social-monitoring on that machine); this repo carries a reference copy under `docs/gtm/demo-creator-skill.md` so it ships with the codebase.
- Creator sessions run in an Orca-managed worktree of this repo on the mini (orca-cli conventions), one session per prospect, sequential by default.
- The reap schedule (expiry teardown) becomes a mini routine (routines skill), daily.
- Secrets: ANTHROPIC_API_KEY from the canonical flowlet/.env; ROUTER_ADMIN_TOKEN from ~/.vendo/demo-router-admin-token (synced to the mini once, manually).

## Task 1: Skill document + repo reference copy
- [ ] Write the skill: trigger phrases, inputs, the exact session-spawn recipe (orca-cli), PLAYBOOK/VERIFY contract references, deploy step, the iMessage report format (link, GIF path, per-beat one-liner, fidelity scores), and the hard rule: report to Yousef only, never outbound
- [ ] Reference copy committed in-repo; mini installation step documented

## Task 2: Reap routine
- [ ] Daily routine on the mini invoking `demo:reap --execute` with the token; failure surfaces via iMessage

## Task 3: Install + end-to-end rehearsal on the mini
- [ ] Install skill + routine on the mini; rehearse the flow once against an already-verified demo (no new build): skill sends the iMessage report for the deployed Linear demo
- [ ] Verify the approval gate wording is unambiguous
