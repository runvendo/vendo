---
"@vendoai/apps": minor
"@vendoai/vendo": minor
"@vendoai/harnesses": minor
---

Reading a file off a sandbox is part of the seam, not each adapter's private
business.

`SandboxMachine.files` — `read`, `write`, `list` — is now declared on the public
interface in `@vendoai/apps`. It already existed three times with an identical
shape, hidden behind `satisfies SandboxMachine & Record<string, unknown> as
SandboxMachine` casts in the e2b and Vendo Cloud adapters and on the fake, and
was missing entirely from two other test doubles: five private spellings (or
absences) of one contract, on the seam a built app's SOURCE has to cross.

The interface now states the answers all of them have to agree on:

- `read` REJECTS for a path the box does not hold — never empty bytes, because a
  silently empty source file is a lost app.
- `write` creates or replaces the whole file and creates the directories on the
  way to it. It never appends.
- `list` is ONE level and names only: entries directly in `dir`, a subdirectory
  as its own name, never a path and never recursive. It rejects for a directory
  the box does not hold, exactly as `read` does.
- `read` hands bytes back UNCHANGED — no text decode, no BOM strip, no
  line-ending normalization — because box content is untrusted and the layer
  above verifies it against the hash in the app's row.

The shared conformance suite (`@vendoai/apps/adapter-conformance`) pins all of
it in one leg that every adapter runs, so no provider can drift. Verified live
against a real e2b sandbox, including a payload of NULs, bare CRs and invalid
UTF-8.

The consolidation paid for itself immediately: a review found that the
in-memory `list` treated the root's prefix as `""` rather than `"/"`, so it
sliced nothing off an absolute path and dropped every name as blank — `list("/")`
answered `[]` on a box full of files. Before `inMemoryBoxFiles` that line existed
in every fake that had a `list` and would have been a separate fix in each. It
was one fix in one file, and the conformance suite now pins the root case for
every implementation.

Two further disagreements the promotion exposed, both invisible while `files` was
private: the Vendo Cloud list route answers deeper than one level, so the Cloud
adapter folds the depth away at the seam; and a missing directory rejected on
real e2b (`[not_found] lstat …`) while both in-memory fakes answered `[]`,
which is how a mistyped source directory reads as an app with no files. The
seam now rejects everywhere.

What went away: two redundant `files` casts on the real adapters, the
`files`-shaped half of the Cloud wire test's private-surface cast, the
`files` cast in three live bootstraps, and three copies of the fakes'
in-memory file semantics (now one `inMemoryBoxFiles`). `SandboxMachineLike` in
`@vendoai/harnesses/claude-code` carries `files`, still structurally and
without widening the subpath's imports. `exec` stays adapter-private.
