---
"@vendoai/vendo": patch
---

The Windows install no longer prints a deprecation warning about our own spawn.
Package managers are `.cmd` shims there, so the install has to go through the
platform shell — but it was passing an args array alongside `shell: true`, and
that pair is DEP0190. Node 24 prints it by default, onto the CLI's own stderr,
so `vendo` interrupted its install with a security warning about itself. Windows
now gets the whole line as one command string; nothing changes on any other
platform.

The quoting the warning was complaining about is still there and still needed —
`cmd.exe` reads a bare `^` (as in `ai@^6`) as an escape character outside double
quotes, and unquoted that spec reaches npm as a different, pinned `ai@6`. It has
just moved into `installSpawnPlan`, which takes its platform as an argument so
the Windows shape can be asserted from an ubuntu-only CI.
