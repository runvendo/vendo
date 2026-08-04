/**
 * Lane E live probe: does the REAL brain, on the real model, write the plan-time
 * display hint (redesign spec §5)? Two asks — one build-shaped, one
 * answer-shaped — against a Maple-like tool menu.
 *
 *   pnpm --filter @vendoai/apps build   # dist is what this imports
 *   ANTHROPIC_API_KEY="$(infisical secrets get ANTHROPIC_API_KEY --plain)" \
 *     node docs/superpowers/evidence/2026-08-03-ui-redesign/lane-e/probe-brain-live.mjs
 *
 * One model call per ask (the brain turn only — no fill workers), so the probe
 * is cheap enough to re-run whenever the brain prompt changes.
 */
const ROOT = new URL("../../../../../", import.meta.url).pathname;
const { runBrainTurn } = await import(`${ROOT}packages/apps/dist/generation/brain.js`);
const { createAnthropic } = await import(
  `${ROOT}examples/demo-bank/node_modules/@ai-sdk/anthropic/dist/index.mjs`
);

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })("claude-sonnet-4-6");

const tools = [
  { name: "maple_accounts_list", description: "Every account this customer holds, with balance and type.", risk: "read" },
  { name: "maple_transactions_list", description: "Transactions for an account, newest first, with merchant and category.", risk: "read" },
  { name: "maple_cards_list", description: "The customer's cards and their status.", risk: "read" },
  { name: "maple_transfer_create", description: "Move money between two accounts.", risk: "write" },
];

const asks = [
  "build me a money HQ — balances across my accounts, spending by category, and a table of recent transactions",
  "what's my current checking balance?",
];

for (const ask of asks) {
  const result = await runBrainTurn({ instruction: ask }, { model, catalog: [], tools });
  const answer = (result.session.filter((turn) => turn.role === "brain").at(-1)?.text ?? "").trim();
  console.log(`ASK  ${ask}`);
  console.log(`  outcome.kind      ${result.outcome?.kind}`);
  console.log(`  plan.display      ${JSON.stringify(result.outcome?.plan?.display)}`);
  console.log(`  first line        ${answer.split("\n")[0]}`);
  console.log(`  issues            ${JSON.stringify(result.issues)}`);
  console.log("");
}
