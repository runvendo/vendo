---
"@vendoai/apps": patch
---

fix: bump esbuild to ^0.28.2 so the Go-compiled binary this package lazy-loads for screen checks carries a crypto/tls past CVE-2025-68121 (esbuild 0.25.12 was built with the EOL go1.23.12; 0.28.2 ships go1.26.5)
