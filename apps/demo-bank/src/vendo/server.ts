import { composioConnector } from "@vendoai/actions";
import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import { vendoAutoJudge } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import { authJs } from "@vendoai/vendo/auth/auth-js";
import { createVendo, vendoModel } from "@vendoai/vendo/server";
import { authSecret, resolveMapleSubject } from "@/server/users";
import { mapleKnowledgeDocs } from "./knowledge";
import { mapleMcpConfig } from "./mcp-config";
import { mapleRegistry } from "./registry";

const composioApiKey = process.env.COMPOSIO_API_KEY;

// One preset fills all three identity seams (09-vendo §2.1): the
// request→Principal resolver, the away/MCP actAs seam, and the door's
// OAuth adapter. `user` maps an Auth.js subject to the seeded Maple
// identity; returning null means "not a Maple user" — the principal
// resolves to anonymous and away/MCP minting for that subject declines.
// Exported so chip pre-generation (chips-seed.ts) can mint the same away
// session the automations path mints — a background seed has no request.
export const mapleAuth = authJs({
  secret: authSecret,
  user: (subject) => {
    const user = resolveMapleSubject(subject);
    return user ? { display: user.display, email: user.email } : null;
  },
});

export const vendo = createVendo({
  // Model + store slots stay UNSET (demo-refresh Part 2): the env ladder
  // resolves them — locally ANTHROPIC_API_KEY, deployed VENDO_API_KEY — and
  // the unset store composes the local default. With the agent slot on the
  // ladder, paint invisibility applies (resolveModels): the paint lane
  // composes the family fast pick — vendo-paint on Cloud, the provider's
  // fast model on BYO — so the demo runs the fast two-lane path with no
  // hardcoded model names (speed-core lane; BYO rule).
  auth: mapleAuth,
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
    // speed-core ruling (2026-07-26, supersedes demo-refresh Part 5):
    // regionParallel is OFF for the demos — live evidence
    // (docs/verification/demo-live-readiness/speed-core/after.md) showed its
    // serial outline + assembly-invalid fallback made creates SLOWER on this
    // surface (p50 55s vs 31.4s without it). endPass stays on: the runtime
    // rides it as the data-sighted verify. structuredRepair and smokeRender
    // are default-on and island repair is the engine's first resort.
    pipeline: {
      endPass: true,
    },
  },
  // Knowledge posture — the same shape as the store slot below. With
  // VENDO_API_KEY set, the slot stays UNSET so the env ladder composes the
  // Cloud knowledge engine and Maple answers from the corpus connected in the
  // console; keyless (a laptop, a fork, CI), the in-memory dev adapter carries
  // Maple's own help-center corpus so citation chips and refusal still demo
  // with no account. The host never constructs a Cloud client itself.
  ...(process.env.VENDO_API_KEY ? {} : { knowledge: memoryKnowledgeAdapter({ docs: mapleKnowledgeDocs }) }),
  policy: { file: ".vendo/policy.json" },
  mcp: mapleMcpConfig(),
  // BYO Composio when Maple brings its own key; otherwise the slot stays
  // UNSET so a VENDO_API_KEY deployment composes the Cloud tools connector
  // (an explicit [] would read as "no connectors, ever" — the seam honors it).
  // connectorApps scopes THAT auto-composed cloud pair to the same toolkits
  // the BYO line uses — the demo never advertises the console's full catalog.
  ...(composioApiKey
    ? { connectors: [composioConnector({ apiKey: composioApiKey, apps: ["gmail", "slack"] })] }
    : { connectorApps: ["gmail", "slack"] }),
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
