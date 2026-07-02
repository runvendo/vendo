/**
 * The stage action host — the bridge between sandbox dispatches and the
 * guardrail policy. A generated component's flowlet.dispatch lands here: the
 * SAME demoPolicy that governs agent tool calls decides allow/approve/deny,
 * and allowed actions execute against the same in-process tools.
 *
 * Approval flow — HARDER than demo-bank's, because this demo's gated writes
 * (delete_email, send_reply, slack_summary) really execute here: an
 * `approve` decision returns { needsApproval, approvalToken } WITHOUT
 * executing; the client re-POSTs with the token after the user consents. The
 * token is one-time, short-lived, and bound to the exact action+payload, so a
 * forged `approved: true` re-POST (demo-bank's noted hole) cannot execute
 * anything the user did not see.
 */
import { randomUUID, createHash } from "node:crypto";
import type { ToolSet } from "ai";
import { buildDescriptor } from "@flowlet/runtime";
import { demoPolicy } from "./policy";
import { DEMO_PRINCIPAL } from "./principal";

interface ActionBody {
  action?: string;
  payload?: unknown;
  approvalToken?: string;
}

/** Consent-time preview: enrich a gated payload with the exact content the
 *  user is approving (e.g. the drafted reply body). See tools.demoPreviews. */
export type ActionPreview = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown> | null>;

export interface ActionResponse {
  status: number;
  body: Record<string, unknown>;
}

interface PendingApproval {
  key: string;
  expiresAt: number;
}

const TOKEN_TTL_MS = 5 * 60 * 1000;

const bindingKey = (action: string, payload: unknown): string =>
  createHash("sha256").update(`${action}\n${JSON.stringify(payload ?? {})}`).digest("hex");

export function createActionHandler(
  tools: ToolSet,
  opts: { now?: () => number; preview?: ActionPreview } = {},
) {
  const now = opts.now ?? Date.now;
  const pending = new Map<string, PendingApproval>();

  const sweep = () => {
    const t = now();
    for (const [token, entry] of pending) {
      if (entry.expiresAt <= t) pending.delete(token);
    }
  };

  return async function handleAction(body: ActionBody): Promise<ActionResponse> {
    sweep(); // reap expired tokens on every request, not just approve traffic
    if (typeof body.action !== "string" || body.action.length === 0) {
      return { status: 400, body: { error: "action (string) is required" } };
    }

    const tool = (tools as Record<string, { execute?: (input: unknown, opts: unknown) => Promise<unknown> }>)[
      body.action
    ];

    const decision = await demoPolicy.evaluate({
      toolName: body.action,
      input: body.payload ?? {},
      descriptor: buildDescriptor(body.action, tool, "caller"),
      principal: DEMO_PRINCIPAL,
    });

    if (decision === "deny") {
      return { status: 403, body: { decision, error: "denied by policy" } };
    }
    if (!tool?.execute) {
      return { status: 404, body: { error: `unknown action "${body.action}"` } };
    }

    if (decision === "approve") {
      if (body.approvalToken) {
        const key = bindingKey(body.action, body.payload);
        const entry = pending.get(body.approvalToken);
        pending.delete(body.approvalToken); // one-time, consumed on any use
        if (!entry || entry.key !== key || entry.expiresAt <= now()) {
          return { status: 403, body: { error: "approval token invalid or expired" } };
        }
        // Token checks out — fall through and execute the payload the user saw.
      } else {
        // Mint: preview the exact content this approval covers (drafted reply
        // body, Slack line), merge it into the payload, and bind the token to
        // the ENRICHED payload — the user approves what will actually run.
        let enriched = (body.payload ?? {}) as Record<string, unknown>;
        if (opts.preview) {
          try {
            const extra = await opts.preview(body.action, enriched);
            if (extra) enriched = { ...enriched, ...extra };
          } catch (error) {
            return {
              status: 400,
              body: { error: error instanceof Error ? error.message : String(error) },
            };
          }
        }
        const token = randomUUID();
        pending.set(token, { key: bindingKey(body.action, enriched), expiresAt: now() + TOKEN_TTL_MS });
        return {
          status: 200,
          body: { decision, needsApproval: true, approvalToken: token, payload: enriched },
        };
      }
    }

    try {
      const result = await tool.execute(body.payload ?? {}, {
        toolCallId: "stage-action",
        messages: [],
      });
      return { status: 200, body: { decision, result } };
    } catch (error) {
      return {
        status: 400,
        body: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  };
}
