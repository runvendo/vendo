import { composioConnector } from "@vendoai/actions";
import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import { vendoAutoJudge } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import { authJs } from "@vendoai/vendo/auth/auth-js";
import { createVendo, guard, vendoModel } from "@vendoai/vendo/server";
import { authSecret, primaryMapleUser, resolveMaplePerson, resolveMapleSubject } from "@/server/users";
import { mapleKnowledgeDocs } from "./knowledge";
import { mapleMcpConfig } from "./mcp-config";
import { namedHarness } from "./proof-harness";
import { mapleRegistry } from "./registry";

const composioApiKey = process.env.COMPOSIO_API_KEY;

// One preset fills all three identity seams (09-vendo §2.1): the
// request→Principal resolver, the away/MCP actAs seam, and the door's
// OAuth adapter. `user` maps an Auth.js subject to the seeded Maple
// identity; returning null means "not a Maple user" — the principal
// resolves to anonymous and away/MCP minting for that subject declines.
export const mapleAuth = authJs({
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
  // Build contract §9.1 — Maple's OWN identity tables answer "which orgs?".
  // One query against what the host already knows; Vendo stores nothing about
  // it. Keyed on the Principal, not the request, so an unattended automation
  // fire resolves the same orgs an attended click does. Both seeded staff are
  // in `maple`; Yousef is the org admin (implicit owner of every org app),
  // Mia is an ordinary member who reaches an app only through a grant.
  memberships: async (principal) => {
    const user = resolveMapleSubject(principal.subject);
    if (!user) return [];
    return [{
      org: "maple",
      display: "Maple Bank",
      teams: ["support"],
      admin: user.subject === primaryMapleUser().subject,
    }];
  },
  // Build contract §9.1 companion — Maple's OWN roster answers "who is the
  // person they typed?". Vendo holds no directory, so this seam is the only
  // reason the Share dialog may offer to share with one person: without it the
  // dialog does not offer it, and the app is never moved for a grant that could
  // not be written. The grant is written for the SUBJECT this returns.
  // The ASKER decides what they may see: Maple answers its own staff and nobody
  // else. One org here, so membership is the same question as "did Maple issue
  // you" — a real deployment would compare the asker's org to the match's.
  resolvePerson: async (query, asker) => {
    if (!resolveMapleSubject(asker.subject)) return null;
    const user = resolveMaplePerson(query);
    return user ? { subject: user.subject, display: user.display } : null;
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
  // Wave-2 live-proof seam (docs/verification/wave2-lane-f/), same shape as the
  // wave-1 MAPLE_HARNESS switch. Unset — the shipped demo — leaves the slot
  // empty, which since the wave-2 flip means the composed `vendo()` serves the
  // chat route. `MAPLE_HARNESS` names a specialist instead, which is the only
  // way to measure a harness column against the default's.
  ...namedHarness(),
  // The remix review seam (/apps/review-queue, /apps/:id/reject-review, and
  // the /dev/inclient-approval door) rides the development composition only.
  // `next start` runs production NODE_ENV, so a local session that drives a
  // real review (the W1e E2E) opts in explicitly; unset, the environment
  // default stands and no deployed surface composes the seam.
  ...(process.env.MAPLE_DEV_SEAMS === "1" ? { development: true } : {}),
  // The shared registry (01 §14): the server reads only the data fields;
  // <VendoRoot> takes the same object and reads only component references.
  catalog: mapleRegistry,
  // The Maple voice (03 §3) — rides the agent prompt every turn.
  instructions: [
    "You are Maple's money assistant. Speak calmly and plainly; no hype.",
    "No emojis, ever — not in prose, not in generated UI text.",
    "Format money as currency (e.g. $1,234.56), never raw cents.",
    "When you render a view, let it carry the data — don't restate it in prose.",
    "For a recurring or scheduled payment/task, use vendo_make — describe the schedule in the request; the automation is armed automatically. There is no separate automations tool.",
  ].join("\n"),
  // Machine-backed execution (layers 2 and 3) is gated by the `sandbox` slot
  // above and nothing else: configure one and Maple can build boxes, leave it
  // out and it cannot. There is no flag here to flip.
  apps: {
    // Remix review (round-2 hardening 2026-08-02): Mia is Maple's host
    // reviewer — this assertion is what lets her read the full review queue,
    // reject, and approve review-kind remixes; a user can never approve
    // their own, so the two-user demo demonstrates the real boundary.
    review: {
      reviewer: (ctx) => resolveMapleSubject(ctx.principal.subject)?.email === "mia@maple.com",
    },
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
  mcp: mapleMcpConfig(),
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
