---
"@vendoai/vendo": patch
---

The claude CLI extraction harness passed its whole prompt as a single argv element, and Windows caps an entire command line at 32,767 characters. A prompt past that ceiling throws `ENAMETOOLONG` before the child process ever starts, while the same prompt sits far under the limit on macOS (~256KB) and Linux (~2MB) — so the failure cannot reproduce off Windows, and it only surfaces once a catalog is large enough to make a stage prompt big. The skeptic re-ask reaches it first, since it carries the judge's proposed fields plus quoted code evidence for every tool in the batch.

It failed quietly, which is why it survived. The re-ask's own handler rejects every field it could not examine, `sync` exits 0, and `doctor` stays green, so a run that discarded most of its completed analysis is indistinguishable from one that worked — the judge had already read the handlers and graded them correctly, and the output was thrown away because the verifier could not be spawned. On a host with ~50 extracted tools, judgments captured went from 10/50 to 40/50 once the ceiling was gone, input schemas from 2/50 to 32/50, and output schemas from 0/50 to 31/50.

The prompt now rides stdin, which `claude -p` already reads when no positional prompt is given, so the ceiling is gone on every platform rather than moved further away. The injected-`exec` seam takes the payload as an optional third argument, leaving existing two-argument stubs untouched, and a regression test drives a 64KB prompt through the harness and asserts no argv element carries it.
