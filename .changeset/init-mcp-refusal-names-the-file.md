---
"@vendoai/vendo": patch
---

`vendo init --use-case mcp` without an OAuth-carrying auth preset refuses the door and told the user to "wire an auth preset — then re-run `npx vendo init`". That was a loop with no exit: the same run goes on to write the anonymous composition, and init never rewrites a composition it already wrote, so every later re-run — `--auth authJs` and `--force` included — printed the identical warning and changed nothing. The message now names the composition file and says to delete it before re-running. The refusal itself is unchanged.
