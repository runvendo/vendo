/**
 * The scripted-demo automation documents. Kept free of the Vendo server
 * composition (seed.ts owns that) so they stay cheap to import and assert on.
 *
 * Three automations spanning the risk ladder, because rehearse()'s payoff is
 * the WRITE path: reads execute for real under the rehearsal venue, while
 * write/destructive tools never reach the registry and resolve to the guard's
 * simulated card carrying the fully resolved args (packages/guard/test/
 * rehearsal-venue.test.ts). A read-only automation rehearses to rows and
 * previews only — necessary as a baseline, not sufficient as a demo.
 *
 *   digest — reads only.           Baseline: what a clean replay looks like.
 *   review — read -> write.        The contrast lives inside ONE firing.
 *   chase  — read -> destructive.  Same card shape, higher risk band.
 *
 * Constraints these documents are shaped around (packages/automations/src/engine.ts):
 *   - rehearse() accepts schedule triggers and `steps` run models ONLY; an
 *     agentic run is rejected outright.
 *   - `fn:` steps are skipped in rehearsal, so every step here is a host tool.
 *   - REHEARSAL_MAX_FIRINGS = 30 over a 7- or 30-day window. Weekly crons keep
 *     a 30-day replay at ~4 firings — few enough to read on screen, where a
 *     daily cron would land on the cap and come back truncated.
 *   - step.args values are JSONata expressions evaluated against
 *     { event, steps, item }, so string literals are quoted INSIDE the
 *     expression ("'cl_rivera'", not "cl_rivera").
 *
 * The reads here all accept `from`/`to`, so the engine pins each firing's
 * window onto them and a replayed firing sees the firm as it stood at its own
 * scheduled time (src/server/asof.ts). That is what makes the firings differ
 * from one another rather than four identical replays of today.
 */
import { DEFAULT_TRIGGER_ID, type AppDocument } from "@vendoai/core"

export type DemoAutomationKey = "digest" | "review" | "chase"

export const DEMO_AUTOMATION_KEYS: DemoAutomationKey[] = ["digest", "review", "chase"]

/** Deterministic per-user app ids (app row ids are global, one subject each). */
export function demoAppId(key: DemoAutomationKey, subject: string): string {
  return `app_demo_${key}_${subject}`
}

/** Read-only baseline. Rehearses to real rows and previews, zero simulated
 *  actions — the control case the other two are read against. */
function deadlineDigestDocument(id: string): AppDocument {
  return {
    format: "vendo/app@1",
    id,
    name: "Monday deadline digest",
    description:
      "Every Monday at 8:00 AM, review the filing calendar and the week's document activity.",
    triggers: [{
      id: DEFAULT_TRIGGER_ID,
      on: { kind: "schedule", cron: "0 8 * * 1" },
      run: {
        kind: "steps",
        steps: [
          { id: "deadlines", tool: "host_listDeadlines" },
          { id: "activity", tool: "host_listActivity", args: { limit: "20" } },
        ],
      },
    }],
  }
}

/** Read -> write. The read answers real data; host_setDocumentStatus (risk
 *  "write") never executes and returns the simulated card instead, so a single
 *  firing shows both halves of the venue side by side.
 *
 *  Pinned to Blue Bottle Coffee, the seeded hero client: its checklist holds
 *  one "received" and one "needs_review" document, so the forEach fans out to
 *  at most two cards per firing; historical as-of reads (../server/asof) can yield
 *  fewer before each upload landed, never an unreadable wall of them. */
function pendingUploadReviewDocument(id: string): AppDocument {
  return {
    format: "vendo/app@1",
    id,
    name: "Verify pending uploads",
    description:
      "Every Tuesday at 9:00 AM, verify Blue Bottle Coffee's uploads that are still awaiting firm review.",
    triggers: [{
      id: DEFAULT_TRIGGER_ID,
      on: { kind: "schedule", cron: "0 9 * * 2" },
      run: {
        kind: "steps",
        steps: [
          { id: "docs", tool: "host_listClientDocuments", args: { id: "'cl_rivera'" } },
          {
            id: "verify",
            tool: "host_setDocumentStatus",
            // Bracketed so a single match still evaluates to an array (JSONata
            // returns a bare object for a one-element sequence, which
            // validateForEachItems rejects).
            forEach: "[steps.docs.data[status='received' or status='needs_review']]",
            args: {
              id: "'cl_rivera'",
              docId: "item.id",
              body: "{'action': 'verify'}",
            },
          },
        ],
      },
    }],
  }
}

/** Read -> destructive. Same simulated-card shape as the write above, one risk
 *  band higher, and the resolved args carry a fully composed client-facing
 *  message — the detail that makes "never executed" land. Capped at the three
 *  soonest deadlines (host_listDeadlines is already sorted soonest-first). */
function documentChaseDocument(id: string): AppDocument {
  return {
    format: "vendo/app@1",
    id,
    name: "Friday document chase",
    description:
      "Every Friday at 5:00 PM, message the three clients closest to their filing deadline who still owe documents.",
    triggers: [{
      id: DEFAULT_TRIGGER_ID,
      on: { kind: "schedule", cron: "0 17 * * 5" },
      run: {
        kind: "steps",
        steps: [
          { id: "deadlines", tool: "host_listDeadlines" },
          {
            id: "chase",
            tool: "host_sendClientMessage",
            forEach: "[steps.deadlines.data[status='missing_docs']][[0..2]]",
            args: {
              id: "item.id",
              body:
                "{'body': 'Hi ' & item.contactName & ' — a quick reminder that " +
                "' & item.businessName & ' still owes ' & $join(item.missingDocKinds, ', ') & " +
                "' ahead of the filing deadline. You can upload these in the client portal. Thanks!', " +
                "'author': 'Maya Alvarez'}",
            },
          },
        ],
      },
    }],
  }
}

const BUILDERS: Record<DemoAutomationKey, (id: string) => AppDocument> = {
  digest: deadlineDigestDocument,
  review: pendingUploadReviewDocument,
  chase: documentChaseDocument,
}

/** The three scripted-demo automations for one seeded subject. */
export function cadenceDemoAutomations(subject: string): AppDocument[] {
  return DEMO_AUTOMATION_KEYS.map(key => BUILDERS[key](demoAppId(key, subject)))
}
