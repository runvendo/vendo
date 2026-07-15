import { describe } from "vitest";
import { ladderLiveLanes } from "../testing/ladder-live.test-util.js";
import { modalSandbox } from "./index.js";

const hasModalCredentials = Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);

// ENG-290 — the same rung-2–4 lanes as e2b/ladder.live.test.ts, on real Modal.
// PARKED until MODAL_TOKEN_ID + MODAL_TOKEN_SECRET exist in the environment:
// the suite is skipped (never run, never red) without those creds, and needs
// no code changes when they appear — set them and run
// `pnpm --filter @vendoai/apps test src/modal/ladder.live.test.ts`.
describe.skipIf(!hasModalCredentials)(
  "modal live lanes (needs MODAL_TOKEN_ID + MODAL_TOKEN_SECRET creds)",
  () => {
    ladderLiveLanes("real Modal", () => modalSandbox({
      tokenId: process.env.MODAL_TOKEN_ID,
      tokenSecret: process.env.MODAL_TOKEN_SECRET,
      timeoutMs: 120_000,
    }), { serverRefPattern: /^modal:v1:/ });
  },
);
