---
"@vendoai/vendo": patch
---

A `package.json` saved with a UTF-8 BOM — what Notepad and PowerShell's `Set-Content` produce — no longer crashes `vendo init` with a raw SyntaxError: the CLI strips a leading BOM everywhere it reads host files (the shared `readOptional`, framework detection, doctor's dependency check, dep-version telemetry, and MCP server.json identity), matching how npm and Node's own `require()` treat the same file. A genuinely malformed `package.json` now fails with one clean sentence — `vendo init: package.json is not valid JSON (…) — fix it and re-run vendo init` — instead of a stack dump.
