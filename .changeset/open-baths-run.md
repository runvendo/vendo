---
---

No release. `store/backends.test-util.ts` is a TEST utility — nothing that ships
imports it, and no exported behaviour changed. It de-registers a shared engine
whose boot rejected, so one flaky PGlite boot stops reporting as every later test
in the file failing on the FIRST one's error, and it gained a pointer to the
fixture-side copy of itself (`fixtures/test-kit/src/shared-store.ts`), which had
no tripwire in that direction.
