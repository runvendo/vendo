// VENDO — a deliberately risky host action (risk: "write" in .vendo/tools.json),
// so the demo exercises Vendo's approval flow. In a real product this would
// email the report; the demo records it and logs.

export interface TripReport {
  recipient: string;
  report: string;
  sentAt: string;
}

/** Demo observability: every "sent" report lands here (and in the server log). */
export const sentTripReports: TripReport[] = [];

export async function sendTripReport(recipient: string, report: string): Promise<{ sent: true; recipient: string }> {
  const entry: TripReport = { recipient, report, sentAt: new Date().toISOString() };
  sentTripReports.push(entry);
  console.log(`[mastra-agent example] trip report sent to ${recipient}: ${report}`);
  return { sent: true, recipient };
}
