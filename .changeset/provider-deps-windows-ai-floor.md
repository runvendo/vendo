---
"@vendoai/vendo": patch
---

`vendo init`'s provider auto-install now runs on Windows — the spawn goes through the platform shell (package managers are `.cmd` shims there) with every arg quoted so caret-bearing specs like `ai@^6` survive cmd.exe — and a failed install's warning carries the installer's own stderr tail instead of a bare "could not install". A resolvable pre-v6 `ai` (typically another package's workspace-hoisted copy) is now a floor violation rather than a satisfied dependency: init installs `ai@^6` over it, and `vendo doctor` fails E-DEP-001 naming your package manager's exact upgrade command and the workspace-hoist story instead of passing green into runtime 500s.
