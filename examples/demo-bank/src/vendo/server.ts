import { anthropic } from "@ai-sdk/anthropic";
import { composioConnector } from "@vendoai/actions";
import type { LimitsCallback, Principal } from "@vendoai/core";
import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import { vendoAutoJudge } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import { authJs } from "@vendoai/vendo/auth/auth-js";
import { createVendo, guard, vendoModel, type HostAuthPreset } from "@vendoai/vendo/server";
import { authSecret, primaryMapleUser, resolveMapleSubject } from "@/server/users";
import { mapleKnowledgeDocs } from "./knowledge";
import { mapleMcpConfig } from "./mcp-config";
import { namedHarness } from "./proof-harness";
// Written by `vendo sync` (the `prebuild`/`predev` step) and gitignored, so it
// exists before anything imports it.
import { remixWiring } from "../../.vendo/generated/remix-wiring";
import { mapleRegistry } from "./registry";
import { mapleRoutes } from "./routes";

const composioApiKey = process.env.COMPOSIO_API_KEY;

// Maple's two honest routes. With a Cloud key, Maple lets Vendo's tenant
// directory answer "which companies?" and enforce the caps set in the console —
// which is the whole point of the feature, and the host assertion below would
// otherwise win over it. Without one, Maple asserts its own orgs and its own
// policy, exactly as it always did.
//
// Truthy, not merely present — the same predicate the SDK's own `environment()`
// applies (wire/shared.ts), so "keyed" means one thing on both sides of the
// seam and an exported-but-blank VENDO_API_KEY does not make Maple stand down
// for a directory that will never answer.
const cloudDirectoryInUse = !!process.env.VENDO_API_KEY;

// Build contract §9.1 — Maple's OWN identity tables answer "which orgs?".
// One query against what the host already knows; Vendo stores nothing about
// it. Keyed on the Principal, not the request, so an unattended automation
// fire resolves the same orgs an attended click does. All four seeded staff
// are in `maple`; Yousef is the org admin (implicit owner of every org app),
// and the rest are ordinary members who reach an app only through a grant.
const mapleMemberships = async (principal: Principal) => {
  const user = resolveMapleSubject(principal.subject);
  if (!user) return [];
  return [{
    org: "maple",
    display: "Maple Bank",
    teams: ["support"],
    admin: user.subject === primaryMapleUser().subject,
  }];
};

// One preset fills all three identity seams (09-vendo §2.1): the
// request→Principal resolver, the away/MCP actAs seam, and the door's
// OAuth adapter. `user` maps an Auth.js subject to the seeded Maple
// identity; returning null means "not a Maple user" — the preset resolves no
// principal, and away/MCP minting for that subject declines.
const mapleAuthJs = authJs({
  secret: authSecret,
  user: (subject) => {
    const user = resolveMapleSubject(subject);
    if (!user) return null;
    return {
      display: user.display,
      email: user.email,
      // Spec 2026-08-05 §1 — the [User] block: what the agent may know about
      // the signed-in customer, asserted fresh every request. Data only.
      facts: {
        name: user.display,
        email: user.email,
        role: user.subject === primaryMapleUser().subject ? "org admin" : "member",
      },
    };
  },
  ...(cloudDirectoryInUse ? {} : { memberships: mapleMemberships }),
});

// Vendo mints no principals, so a logged-out visitor has no identity unless
// MAPLE gives them one — that is the host's call, not Vendo's. Maple's demo is
// browsable signed out, so it resolves those visitors to one shared ephemeral
// guest: every logged-out visitor of this deployment is the SAME subject and
// therefore sees the same threads and apps. Acceptable because the demo runs
// locally; a real deployment would sign visitors in, or key the guest subject
// off something of its own.
const MAPLE_GUEST: Principal = { kind: "user", subject: "maple_guest", ephemeral: true };

export const mapleAuth: HostAuthPreset = {
  ...mapleAuthJs,
  principal: async (request) => (await mapleAuthJs.principal(request)) ?? MAPLE_GUEST,
};

// Vendo counts, Maple decides. All four seeded staff are members of `maple`, so
// the `org:maple` pool exists without Maple wiring one: the branch shares one
// rolling monthly allowance, and no single person can spend it all.
//
// Guarded on `user.pools`: Maple serves identities it asserts no membership for —
// the signed-out guest, an inbound text, a deployment with no password env — and
// counting a pool they are not in is an error, so an unguarded count would refuse
// every one of those turns instead of falling through to the per-person cap.
export const mapleLimits: LimitsCallback = async ({ user, action, count }) => {
  if (action !== "message") return true;
  if (user.pools?.includes("org:maple")
    && await count("message", { days: 30, pool: "org:maple" }) >= 200) {
    return {
      allow: false,
      message: "Maple Bank has used its 200 shared messages for this month. They free up as the last 30 days roll past.",
    };
  }
  if (await count("message", { days: 1 }) >= 50) {
    return {
      allow: false,
      message: "That's your 50 messages for today. The branch's allowance is shared, so this picks back up tomorrow.",
    };
  }
  return true;
};

export const vendo = createVendo({
  // Model posture, written down rather than sniffed: env keys are credentials,
  // config selects. The DEPLOYED demo leaves the seats unset so VENDO_API_KEY
  // fills each one with its own Cloud family id (vendo / vendo-apps /
  // vendo-review) and no hardcoded ids. Locally, Maple brings its own Anthropic
  // account, so it NAMES the seats here — an ANTHROPIC_API_KEY lying in the
  // shell no longer wins the seat by itself, and an explicit `default` is
  // borrowed by every unset seat, so the fast lane is spelled out to keep the
  // two-lane speed the demo relies on.
  // `@ai-sdk/anthropic` reads the key itself; Vendo never sees it. `judge` is
  // here for the same reason: the guard judge below is wired from the STRING
  // `vendoModel("vendo-judge")`, and a string rides the ladder — which on this
  // laptop resolves nothing now, so the seat has to name the model.
  //
  // NON-BLANK, not merely present: an exported-but-empty `ANTHROPIC_API_KEY` is
  // an ordinary thing to have around, and naming the seats for one would preempt
  // the VENDO_API_KEY fallback that was about to fill them correctly. Same rule
  // the SDK's own detection uses, so "set" means one thing everywhere.
  ...((process.env.ANTHROPIC_API_KEY ?? "").trim() !== ""
    ? {
        models: {
          default: anthropic("claude-sonnet-4-6"),
          apps: anthropic("claude-sonnet-4-6"),
          review: anthropic("claude-haiku-4-5"),
          judge: anthropic("claude-haiku-4-5"),
        },
      }
    : {}),
  auth: mapleAuth,
  // Unset — the shipped demo — leaves the harness slot empty, so the composed
  // `vendo()` serves the chat route. `MAPLE_HARNESS` names a specialist
  // instead; fixtures/context-e2e is the only caller (see ./proof-harness.ts).
  ...namedHarness(),
  // The development-only surfaces (POST /sync/impact, the /doctor probes) ride
  // the development composition only. `next start` runs production NODE_ENV, so
  // a local session that needs them opts in explicitly; unset, the environment
  // default stands and no deployed surface composes them.
  ...(process.env.MAPLE_DEV_SEAMS === "1" ? { development: true } : {}),
  // The shared registry (01 §14): the server reads only the data fields;
  // <VendoRoot> takes the same object and reads only component references.
  components: mapleRegistry,
  // The ported slots' holes, so the checks floor types a ported screen against
  // the same names the renderer paints it by. Without this the floor refuses
  // every port with "@vendo/screen has no exported member 'AreaChart'".
  remixWiring,
  // The same route map <VendoRoot> gives the provider — one registry, both sides.
  routes: mapleRoutes,
  // The Maple voice (03 §3) — rides the agent prompt every turn.
  instructions: [
    "You are Maple's money assistant. Speak calmly and plainly; no hype.",
    "No emojis, ever — not in prose, not in generated UI text.",
    "Format money as currency (e.g. $1,234.56), never raw cents.",
    "When you render a view, let it carry the data — don't restate it in prose.",
  ].join("\n"),
  // Machine-backed execution (layers 2 and 3) is gated by the `sandbox` slot
  // above and nothing else: configure one and Maple can build boxes, leave it
  // out and it cannot. There is no flag here to flip.
  apps: {
    // There is ONE generation pipeline now (the 2026-07-28 rebuild), so the
    // speed-core knobs this demo used to amend — regionParallel off, endPass on
    // — no longer exist: the lanes they chose between are deleted. The island
    // smoke-render gate is the only flag left and it is on by default.
  },
  // Knowledge posture — the same shape as the store slot below. With
  // VENDO_API_KEY set, the slot stays UNSET so the env ladder composes the
  // Cloud knowledge engine and Maple answers from the corpus connected in the
  // console; keyless (a laptop, a fork, CI), the in-memory dev adapter carries
  // Maple's own help-center corpus so citation chips and refusal still demo
  // with no account. The host never constructs a Cloud client itself.
  ...(process.env.VENDO_API_KEY ? {} : { knowledge: memoryKnowledgeAdapter({ docs: mapleKnowledgeDocs }) }),
  // The deployment's rules, in one value. Guard auto-judge on unconditionally
  // (demo-refresh Part 2): run/ask/block rulings on tool calls ride the vendo
  // model family's judge lane — vendo-judge on the Cloud gateway, the
  // provider's fast pick on BYO rungs.
  guard: guard({
    policy: { file: ".vendo/policy.json" },
    judge: vendoAutoJudge({ model: vendoModel("vendo-judge") }),
  }),
  ...(cloudDirectoryInUse ? {} : { limits: mapleLimits }),
  // The 24-tool default belt is sized for a 600-tool catalog (tool-search.ts):
  // past it, everything is one `find_tools` away. Maple's whole surface is ~31
  // tools, comfortably inside the 30-50 band that file cites as the accurate
  // one — and the default cut it safest-first, which on 25 reads and 6 writes
  // means every WRITE was evicted. Twice in two days that buried `vendo_text_me`
  // and an armed automation told the customer it could not text them. Raised
  // here rather than lowered in the block: the cap is right for the catalog it
  // was written for, and wrong for a demo bank.
  maxInitialTools: 64,
  mcp: mapleMcpConfig(),
  // Maple's customers can text the assistant: they link their phone from the
  // "Text with Maple" card on /settings (components/settings/text-channel-card.tsx
  // — a QR and a prefilled first text), and every text after that runs as them.
  // Vendo Cloud carries the numbers, so this needs VENDO_API_KEY; the phone ↔
  // customer binding stays in Maple's own store.
  channels: { text: true },
  // BYO Composio when Maple brings its own key; otherwise the slot stays
  // UNSET so a VENDO_API_KEY deployment composes the Cloud tools connector
  // (an explicit [] would read as "no connectors, ever" — the seam honors it).
  // No apps scoping (2026-07-30 ruling): the dock offers every toolkit with
  // an enabled auth config on the account, so new connectors go live by
  // enabling them in Composio — no redeploy.
  ...(composioApiKey ? { connectors: [composioConnector({ apiKey: composioApiKey })] } : {}),
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
