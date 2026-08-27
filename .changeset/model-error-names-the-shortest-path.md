---
"@vendoai/agents": patch
---

The `agent({ model }) is required` error now names the zero-key path first. It fires precisely when no credential rung resolved, yet it listed only the bring-your-own escape hatches — `model: anthropic(...)` and `harness: claudeCode()` — and never mentioned `npx vendoai@latest login` / `VENDO_API_KEY`, which is the cheapest fix and the one the backend quickstart recommends. A reader of the error had no way to learn about it from the error.
