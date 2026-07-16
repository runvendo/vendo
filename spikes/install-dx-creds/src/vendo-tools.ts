/**
 * SPIKE — stand-ins for Vendo's host tools (mirrors the ToolRegistry shape in
 * packages/agent: descriptor {name, description, inputSchema, risk} + execute).
 *
 * Two tools chosen to exercise both approval branches of Vendo's guard:
 * - vendo_payments_list: risk "read"  → auto-allow
 * - vendo_payments_send: risk "write" → guard says "ask"; the call must PARK
 *   until a (simulated) human approves, then resume with the real result.
 */

export interface SpikeToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: "read" | "write";
}

export const SPIKE_TOOLS: SpikeToolDescriptor[] = [
  {
    name: "vendo_payments_list",
    description:
      "List the user's recent payments. Read-only. Returns id, payee and amount for each payment.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "max rows" } },
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "vendo_payments_send",
    description:
      "Send a payment to a payee. DESTRUCTIVE: moves real money. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        payee: { type: "string" },
        amountCents: { type: "number" },
      },
      required: ["payee", "amountCents"],
      additionalProperties: false,
    },
    risk: "write",
  },
];

/** Deterministic fake host API (what registry.execute would hit). */
export function executeSpikeTool(name: string, args: unknown): unknown {
  if (name === "vendo_payments_list") {
    return {
      payments: [
        { id: "pay_1", payee: "Acme Water Co", amountCents: 4200 },
        { id: "pay_2", payee: "Metro Electric", amountCents: 9150 },
      ],
    };
  }
  if (name === "vendo_payments_send") {
    const a = args as { payee?: string; amountCents?: number };
    return {
      status: "sent",
      confirmation: "conf_spike_001",
      payee: a?.payee ?? "?",
      amountCents: a?.amountCents ?? 0,
    };
  }
  throw new Error(`unknown spike tool: ${name}`);
}

/**
 * Simulated Vendo approval broker. When the guard says "ask" the tool call
 * parks on a promise; a "user" resolves it later. In the measurements we
 * resolve after `approvalDelayMs` to prove the ridden session tolerates an
 * arbitrary-length park and then RESUMES the same tool call.
 */
export class ApprovalBroker {
  private pending = new Map<string, (approved: boolean) => void>();
  public log: Array<{ event: string; at: number; detail?: string }> = [];

  mark(event: string, detail?: string): void {
    this.log.push({ event, at: Date.now(), detail });
  }

  /** Park until decide() is called for this id. */
  waitForDecision(id: string): Promise<boolean> {
    this.mark("approval-parked", id);
    return new Promise((resolve) => {
      this.pending.set(id, (approved) => {
        this.mark(approved ? "approval-granted" : "approval-denied", id);
        resolve(approved);
      });
    });
  }

  decide(id: string, approved: boolean): boolean {
    const fn = this.pending.get(id);
    if (!fn) return false;
    this.pending.delete(id);
    fn(approved);
    return true;
  }

  /** Simulate the human clicking Approve after `ms`. */
  autoApproveAfter(id: string, ms: number): void {
    setTimeout(() => this.decide(id, true), ms);
  }
}
