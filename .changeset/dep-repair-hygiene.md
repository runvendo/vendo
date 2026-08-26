---
"@vendoai/vendo": patch
---

fix: ignore the host repo's lifecycle scripts during automatic dep repair, and POSIX-quote the displayed install commands so a cwd with a space or shell metachar can't be misread.
