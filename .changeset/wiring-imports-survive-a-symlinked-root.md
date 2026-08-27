---
"@vendoai/actions": patch
---

The generated wiring file imports the host's own modules even when the project
root is reached through a symlink.

`remix-wiring.ts` binds each ported slot by importing the host's functions and
components relative to itself, and the two ends of that relative path were
measured in different spaces: `resolveImportSource` realpaths every module it
returns, while the generated directory came straight off the root as given. A
root behind a symlink — a macOS temp directory, a linked checkout — made the two
disagree, and the emitted import climbed out of the project into an absolute
machine path (`../../../../../../../../private/var/folders/…/src/lib/api-client`)
baked into a file the host commits. The generated directory is realpathed before
the split measures against it, so both ends count the same tree and the import
comes out as `../../src/lib/api-client` on every machine.
