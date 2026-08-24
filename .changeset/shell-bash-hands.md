---
"@vendoai/core": minor
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
guard's rules, grants and approvals apply to it unchanged, and every call lands
an audit row.

`createVendo({ shell: false })` withholds it; `createVendo({ shell: { limits } })`
moves its per-call wall clock (30 s) and output ceiling (1 MB). It composes for
the resident brain only — a harness that thinks on a machine already has a real
disk and reaches it its own way.
