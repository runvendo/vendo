/**
 * The two conversational-steering tools (ENG-193 spec §3 Moment 11, §4.8,
 * item-6 scope ruling #1). Both are chat-invoked, server-executed engine
 * tools — the model calls them when the user steers policy in plain
 * English.
 *
 * `always_ask_before` (TIGHTEN): act tier (mutating, not dangerous) — the
 * judge's OWN intent-match (`judge-policy.ts`) is what lets a genuinely
 * user-requested tighten auto-execute with a receipt (Moment 11's "Got
 * it"). Without a judge configured it falls back to a normal approval card,
 * same as every other act-tier call in that configuration — a safe, not
 * broken, default (see this item's plan, Task 11, for the live-verification
 * setup that turns the judge on). FALSE-ASSURANCE FIX (review follow-up):
 * before compiling a rule, `toolPattern` is validated against
 * `config.knownToolNames()` — a non-glob pattern must resolve via
 * `resolveDescriptor`, a glob must match at least one known name — so a
 * typo'd or nonexistent target never silently mints a rule that can never
 * fire while the model reports success anyway.
 *
 * `stop_asking_about` (LOOSEN): CRITICAL tier by construction (spec
 * principle 7: "tools that change permissions ... are themselves
 * critical-tier") — it ALWAYS shows the full ceremony card via the EXISTING
 * critical-tier path (no new wire object). Its `execute` — which only ever
 * runs after that card is confirmed, since `wrapTool` re-evaluates the
 * composed policy fresh at execute time and critical is unsuppressible by
 * type (`grant-policy.ts`) — mints the standing grant. `grantManager.create`
 * already refuses a critical TARGET by descriptor; this tool additionally
 * refuses an UNVERIFIED target explicitly (item-6 ruling #1's "ALSO refuse
 * unverified targets" — `grantManager` itself only ever checked critical).
 *
 * SINGLE-TENANT SCOPE (documented limitation, same as
 * `automations/tools.ts`'s `createAutomationTools`, see this item's plan
 * deviation #1): `config.principal` is fixed at construction, not
 * re-resolved per chat request. Both hosts that wire this
 * (`@flowlet/next`, the accounting demo) already accept this limitation for
 * automation authoring tools; steering tools merge into the SAME static
 * server toolset and inherit it rather than introducing a new one.
 */
import { tool, type Tool, type ToolSet } from "ai";
import { z } from "zod";
import type { AuditLog, CompiledRuleStore, GrantStore, Principal } from "@flowlet/core";
import { grantConstraintSchema } from "@flowlet/core";
import type { ToolDescriptor } from "./descriptor";
import { createRuleManager } from "./rule-manager";
import { createGrantManager } from "./grant-manager";
import { isUnverified } from "./policy/tier";
import { globMatches } from "./policy/grant-match";

export interface SteeringToolsConfig {
  principal: Principal;
  rules: CompiledRuleStore;
  grants: GrantStore;
  audit: AuditLog;
  /** Resolves the LIVE descriptor of the TARGET tool named in a
   *  `stop_asking_about` call — the same static resolver each host already
   *  builds for the consent endpoint (ENG-193 §4.5 ruling (c)). */
  resolveDescriptor: (toolName: string) => ToolDescriptor | undefined;
  /**
   * Every tool name currently registered on this mount (host + server +
   * automation-authoring + this steering bucket itself) — the SAME closed
   * world each host already computes for its `GET /critical-tools` route.
   * Required, not optional (review follow-up, FALSE-ASSURANCE FIX): without
   * it, `always_ask_before` would happily compile a rule for a typo'd tool
   * name or a glob that matches nothing, and the model would report success
   * ("Got it") for a rule that can never fire — a confident lie. A host that
   * omits this gets a loud type error instead of that silent failure mode.
   */
  knownToolNames: () => string[];
  now?: () => string;
}

/** Cheap, dependency-free "did you mean" suggestions — substring match
 *  either direction, case-insensitive. Good enough to nudge the model toward
 *  the real name without a fuzzy-matching library; exact ranking doesn't
 *  matter, just narrowing the search. */
function closeMatches(pattern: string, known: string[]): string[] {
  const needle = pattern.toLowerCase();
  return known
    .filter((name) => {
      const hay = name.toLowerCase();
      return hay.includes(needle) || needle.includes(hay);
    })
    .slice(0, 3);
}

/**
 * FALSE-ASSURANCE FIX (review follow-up): validate `toolPattern` against the
 * host's known tool names BEFORE compiling a rule. A non-glob pattern must
 * resolve to a real, registered tool (reuses `resolveDescriptor` — the same
 * check `stop_asking_about` already relies on); a glob must match at least
 * one known name. Every uncertainty fails closed to `{ ok: false }` — the
 * model gets a correctable error, never a rule that silently never fires.
 */
function validateToolPattern(
  toolPattern: string,
  config: SteeringToolsConfig,
): { ok: true } | { ok: false; error: string } {
  const isGlob = toolPattern.includes("*");
  if (!isGlob) {
    if (config.resolveDescriptor(toolPattern)) return { ok: true };
    const suggestions = closeMatches(toolPattern, config.knownToolNames());
    return {
      ok: false,
      error:
        suggestions.length > 0
          ? `unknown tool "${toolPattern}" — did you mean ${suggestions.map((s) => `"${s}"`).join(" or ")}? ` +
            "Double-check the exact tool name and try again."
          : `unknown tool "${toolPattern}" — no registered tool has that name. Double-check the exact tool name and try again.`,
    };
  }
  const known = config.knownToolNames();
  if (known.some((name) => globMatches(toolPattern, name))) return { ok: true };
  return {
    ok: false,
    error: `the pattern "${toolPattern}" doesn't match any registered tool. Check the glob and try again.`,
  };
}

/** `buildDescriptor` reads a top-level `annotations` field — this is how the
 *  existing tier/policy machinery learns these tools' danger tier, exactly
 *  like `automations/tools.ts`'s `markDestructive`. Explicit `false`/`false`
 *  (not omission) lands on "act" AND avoids the "unverified" flag
 *  (`isUnverified` requires ALL THREE hints absent; we know exactly what
 *  this tool is). */
function markAct<T extends Tool>(t: T): T {
  return Object.assign(t, { annotations: { readOnlyHint: false, destructiveHint: false } });
}

function markCritical<T extends Tool>(t: T): T {
  return Object.assign(t, { annotations: { destructiveHint: true } });
}

export function createSteeringTools(config: SteeringToolsConfig): ToolSet {
  const ruleManager = createRuleManager({ store: config.rules, audit: config.audit, now: config.now });
  const grantManager = createGrantManager({ store: config.grants, audit: config.audit, now: config.now });

  const alwaysAskBefore = markAct(
    tool({
      description:
        "Call this when the user says something like 'always ask before X' / 'always check with " +
        "me before Y' / 'make sure to ask before Z' — they are asking you to tighten your OWN " +
        "behavior going forward, not asking you to do X/Y/Z right now. Compile their words into a " +
        "deterministic rule; do not just remember it in conversation.",
      inputSchema: z.object({
        toolPattern: z.string().describe(
          "The exact tool name this should apply to, OR a glob using * to cover a family " +
            "(e.g. 'GMAIL_*'). Prefer the exact name unless the user clearly means a whole category.",
        ),
        constraint: grantConstraintSchema.optional().describe(
          "Optional narrowing on the call's input, e.g. { path: 'to', op: 'matches', value: '*@acme.co' } " +
            "for 'anyone at Acme'. Omit to cover every call matching toolPattern.",
        ),
        plainText: z.string().describe(
          "Short natural-language phrase describing the rule back to the user, e.g. " +
            "'emailing anyone at Acme'. Used verbatim in the confirmation and on the Trust screen.",
        ),
      }),
      execute: async ({ toolPattern, constraint, plainText }) => {
        const validation = validateToolPattern(toolPattern, config);
        if (!validation.ok) return validation;
        const rule = await ruleManager.create(config.principal, {
          kind: "always_ask",
          toolPattern,
          ...(constraint ? { constraint } : {}),
          plainText,
        });
        return { ok: true, ruleId: rule.id, confirmation: `Got it — I'll always ask before ${plainText}.` };
      },
    }),
  );

  const stopAskingAbout = markCritical(
    tool({
      description:
        "Call this when the user says something like 'stop asking about X' / 'you can just do Y " +
        "without checking' / 'always allow Z' — they are asking you to loosen your OWN behavior " +
        "going forward. This ALWAYS requires their explicit confirmation (permission-changing " +
        "actions always do) — call it and let the confirmation card do the gating; do not refuse " +
        "to call it just because it feels sensitive.",
      inputSchema: z.object({
        toolName: z.string().describe("The exact tool name to stop asking about."),
        constraint: grantConstraintSchema.optional().describe(
          "Optional narrowing on the call's input, same shape as always_ask_before's.",
        ),
        plainText: z.string().describe(
          "Short natural-language phrase confirming what will no longer need approval, e.g. " +
            "'sending reminder emails to your clients'.",
        ),
      }),
      execute: async ({ toolName, constraint, plainText }) => {
        const descriptor = config.resolveDescriptor(toolName);
        if (!descriptor) return { ok: false, error: `unknown tool "${toolName}"` };
        if (isUnverified(descriptor)) {
          return { ok: false, error: `"${toolName}" is an unverified tool — refusing to loosen it` };
        }
        try {
          const grant = await grantManager.create(
            config.principal,
            {
              tool: toolName,
              scope: constraint ? { kind: "constrained", constraints: [constraint] } : { kind: "tool" },
              duration: "standing",
              source: { kind: "compiled-rule", rule: plainText },
            },
            descriptor,
          );
          return { ok: true, grantId: grant.id, confirmation: `Done — I won't ask again before ${plainText}.` };
        } catch (err) {
          // grantManager itself refuses a CRITICAL target by descriptor (a
          // dangerTier check) — this surfaces that refusal as a correctable
          // tool result, not a thrown error the model can't recover from.
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  );

  return { always_ask_before: alwaysAskBefore, stop_asking_about: stopAskingAbout };
}
