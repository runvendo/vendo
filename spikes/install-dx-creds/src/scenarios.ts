/** SPIKE — the three measured scenarios, shared by every rung. */

export const APPROVAL_DELAY_MS = 3000;

export const SCENARIOS = {
  /** Pure text turn; the interactive-latency headline number. */
  short: "Reply with exactly: pong",
  /** One read-risk host tool round-trip. */
  toolRead: "How many recent payments do I have? Use your payments list tool and answer with the count.",
  /**
   * One write-risk host tool round-trip. The guard parks the call for
   * APPROVAL_DELAY_MS (simulated human), then approves; the turn must resume
   * and report the confirmation id. Total latency includes the park.
   */
  toolApprove:
    "Send a payment of 1250 cents to 'Acme Water Co' using your payment tool, then tell me the confirmation id.",
} as const;

export const TRIALS = 4;
