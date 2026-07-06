import { configure } from "@testing-library/react";

// Full-thread tests (VendoThread/approval-resume/slot) mount the entire
// provider stack and drive a scripted agent turn through several waitFor/
// findBy waits. testing-library's default asyncUtilTimeout (1s) is tuned for
// a quiet machine — under a loaded, parallel monorepo CI runner the same
// waits can legitimately take longer even though nothing is actually stuck,
// so give them CI headroom instead of flaking.
configure({ asyncUtilTimeout: 10_000 });
