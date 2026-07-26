import { composioConnector } from "@vendoai/actions";
import { vendoAutoJudge } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import { authJs } from "@vendoai/vendo/auth/auth-js";
import { createVendo, vendoModel } from "@vendoai/vendo/server";
import { authSecret, resolveMapleSubject } from "@/server/users";
import { mapleMcpConfig } from "./mcp-config";
import { mapleRegistry } from "./registry";

const composioApiKey = process.env.COMPOSIO_API_KEY;

export const vendo = createVendo({
  // Model + store slots stay UNSET (demo-refresh Part 2): the env ladder
  // resolves them — locally ANTHROPIC_API_KEY, deployed VENDO_API_KEY — and
  // the unset store composes the local default. Known deliberate regression
  // until the model-family lane lands: paint rides the main model.
  // One preset fills all three identity seams (09-vendo §2.1): the
  // request→Principal resolver, the away/MCP actAs seam, and the door's
  // OAuth adapter. `user` maps an Auth.js subject to the seeded Maple
  // identity; returning null means "not a Maple user" — the principal
  // resolves to anonymous and away/MCP minting for that subject declines.
  auth: authJs({
    secret: authSecret,
    user: (subject) => {
      const user = resolveMapleSubject(subject);
      return user ? { display: user.display, email: user.email } : null;
    },
  }),
  // The shared registry (01 §14): the server reads only the data fields;
  // <VendoRoot> takes the same object and reads only component references.
  catalog: mapleRegistry,
  // Guard auto-judge on unconditionally (demo-refresh Part 2): run/ask/block
  // rulings on tool calls ride the vendo model family's judge lane —
  // vendo-judge on the Cloud gateway, the provider's fast pick on BYO rungs.
  judge: vendoAutoJudge({ model: vendoModel("vendo-judge") }),
  // The Maple voice (03 §3 agent.instructions) — rides the agent prompt every turn.
  agent: {
    instructions: [
      "You are Maple's money assistant. Speak calmly and plainly; no hype.",
      "No emojis, ever — not in prose, not in generated UI text.",
      "Format money as currency (e.g. $1,234.56), never raw cents.",
      "When you render a view, let it carry the data — don't restate it in prose.",
    ].join("\n"),
  },
  // execution-v2 Waves 4+9 — the layer-2 (machines) and layer-3 (served apps)
  // experimental opt-ins are host decisions; Maple flips them via its own env
  // so demos can gate on/off. Served apps require machines, so the served
  // flag implies the machines flag here.
  apps: {
    experimentalServedApps: process.env.VENDO_EXPERIMENTAL_SERVED_APPS === "1",
    experimentalMachines: process.env.VENDO_EXPERIMENTAL_MACHINES === "1"
      || process.env.VENDO_EXPERIMENTAL_SERVED_APPS === "1",
    // RE-GATE 2026-07-26 CANDIDATE CONFIG — REVERTED after the run.
    // Selected at boot by VENDO_GATE_ARM (arm order randomized PER PROMPT by
    // the committed schedule; one env-switched seam avoids a rebuild between
    // creates). Replaces the production full-v4 pipeline block FOR THE RUN
    // ONLY, mirroring the 2026-07-25 rematch arms exactly:
    //   A (unset) = the rematch's production-defaults arm: pipeline {}
    //   B = { endPass: true } — current contract + data-sighted verify
    //   C = { exemplarContract: true, endPass: true }
    // NOTE: production on main now ships the FULL v4 pipeline (demo-refresh
    // Part 5), so arm A is the rematch control, not today's shipped config —
    // kept identical for cross-run comparability of the healed mechanisms.
    // Configuration selection, not tuning. REVERTED after the run.
    pipeline: process.env.VENDO_GATE_ARM === "C"
      ? { exemplarContract: true, endPass: true }
      : process.env.VENDO_GATE_ARM === "B"
        ? { endPass: true }
        : {},
  },
  policy: { file: ".vendo/policy.json" },
  mcp: mapleMcpConfig(),
  // BYO Composio when Maple brings its own key; otherwise the slot stays
  // UNSET so a VENDO_API_KEY deployment composes the Cloud tools connector
  // (an explicit [] would read as "no connectors, ever" — the seam honors it).
  ...(composioApiKey
    ? { connectors: [composioConnector({ apiKey: composioApiKey, apps: ["gmail", "slack"] })] }
    : {}),
  // Store posture — an explicit demo decision (README "Store posture"). The
  // DEPLOYED demo leaves this slot unset so the VENDO_API_KEY env ladder
  // composes the Cloud HOSTED store: Railway's container filesystem is
  // ephemeral, so a container-local store would silently wipe demo state on
  // every redeploy, while hosted state survives (and Cloud stays the single
  // firing authority for schedule automations). MAPLE_STORE=local pins a
  // local PGlite store instead — the local-dev posture (.env.local), so a
  // laptop never shares the deployed demo's tenant. An explicitly passed
  // store wins over the key default, per the adapter rule.
  ...(process.env.MAPLE_STORE === "local" ? { store: createStore() } : {}),
});
