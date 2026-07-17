#!/usr/bin/env node
/**
 * ENG-338 finale demo: drives the REAL `vendo init` (from the built worktree)
 * against the clean-room app with only the TTY prompts seamed to "yes" —
 * ladder step, consent recording, dev-server start, browser open (captured),
 * and the adaptive seeded first turn all run for real on the claude rung.
 */
import { runInit } from "/tmp/vendo-eng338/packages/vendo/dist/cli/init.js";

delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.VENDO_API_KEY;
delete process.env.VENDO_DEV_CREDENTIAL;
process.env.PORT = "3409";

const opened = [];
const code = await runInit({
  targetDir: "/tmp/eng338-e2e/app",
  output: {
    log: (message) => console.log(message),
    error: (message) => console.error(message),
  },
  // Interview + diffs auto-accepted (already initialized; idempotent).
  interview: async () => ({}),
  confirm: async () => true,
  offerRefine: async () => false,
  devMode: {
    confirm: async (question) => {
      console.log(`[prompt] ${question} → yes`);
      return true;
    },
  },
  finale: {
    confirm: async (question) => {
      console.log(`[prompt] ${question} → yes`);
      return true;
    },
    openBrowser: (url) => {
      opened.push(url);
      console.log(`[browser] would open ${url}`);
    },
    waitForServerExit: false,
  },
});
console.log(`\ninit exit=${code}; browser opens=${JSON.stringify(opened)}`);
process.exit(code);
