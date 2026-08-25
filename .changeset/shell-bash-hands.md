---
"@vendoai/core": minor
"@vendoai/guard": minor
"@vendoai/harnesses": minor
"@vendoai/vendo": minor
---

The agent has hands: one real `bash` over the user's own files.

Every deployment running the default `vendo()` harness — no keys, no config —
now projects one more tool: `bash`. It is a full shell (grep, sed, awk, jq, sort,
cut, find, pipes, redirection) running IN THIS PROCESS over the same per-user
workspace the file drawer already lives in, so a dropped CSV is something the
agent can actually work on instead of something it can only page through 200
lines at a time. There is no machine to provision, no sandbox key, and no network
or package manager inside the shell — the interpreter is
[just-bash](https://www.npmjs.com/package/just-bash) and the filesystem is the
store, so the mounts the workspace already enforces (`/user` and
`/orgs/<org>` writable, `/host` read-only, everything else `EACCES`) are the whole
containment story. Each session also gets an in-memory `/tmp` that lasts the
conversation and is never saved.

It rides the ONE guarded registry like every other tool: graded `write`, so the
host's rules, grants and the kill switch apply to it unchanged, and every call
lands an audit row.

One security default moves with it, and it is worth reading twice: the
`cautious` preset no longer raises an approval card for `bash`. It is the only
tool exempted, and only from the prompt — the `write` grade is exactly what keeps
the audit row, the host's own rules and the kill switch over it. A shell that
asked before every `wc -l` would be unusable in chat and simply cannot run in an
automation, which has nobody to answer the card. A deployment that wants the
confirmation back adds a rule of its own for `bash`, and it wins.

`createVendo({ shell: false })` withholds it; `createVendo({ shell: { limits } })`
moves its per-call wall clock (30 s) and output ceiling (1 MB). It composes for
the resident brain only — a harness that thinks on a machine already has a real
disk and reaches it its own way.
