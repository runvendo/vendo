"use client";

/**
 * Client-side connect flow, used by the in-thread DemoConnectCard and the
 * "+ Connect tools" selector.
 *
 * It asks the server to connect a toolkit:
 *   - Already authorized in Composio (the demo case: Gmail/Slack) -> the server
 *     verifies the live connection and returns connected:true. Fast + reliable,
 *     no popup, no flaky OAuth.
 *   - Not yet authorized -> the server returns the real OAuth redirectUrl; we
 *     open it in a popup and poll until the connection is ACTIVE. If the browser
 *     blocks the popup we hand the URL back so the card can show an Authorize link.
 */

const POLL_MS = 1500;
const TIMEOUT_MS = 120_000;
const POPUP_FEATURES = "width=520,height=680,menubar=no,toolbar=no";

export type ConnectOutcome =
  | { result: "active" }
  | { result: "failed" }
  | { result: "timeout" }
  | { result: "needs-auth"; redirectUrl: string };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ConnectResponse {
  connected: boolean;
  redirectUrl?: string | null;
  connectedAccountId?: string;
}

async function postConnect(toolkit: string): Promise<ConnectResponse> {
  const res = await fetch("/api/flowlet/integrations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: toolkit, action: "connect" }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`connect failed: ${res.status}`);
  const json = (await res.json()) as { data?: ConnectResponse };
  return json.data ?? { connected: false };
}

async function pollStatus(toolkit: string, account: string): Promise<"active" | "pending" | "failed"> {
  const res = await fetch(
    `/api/flowlet/integrations?status&id=${encodeURIComponent(toolkit)}&account=${encodeURIComponent(account)}`,
    { cache: "no-store" },
  );
  if (!res.ok) return "failed";
  const json = (await res.json()) as { data?: { status?: string } };
  const status = json.data?.status;
  return status === "active" || status === "failed" ? status : "pending";
}

export async function runConnectFlow(toolkit: string): Promise<ConnectOutcome> {
  const res = await postConnect(toolkit);

  // Fast path: already authorized -> the store is now marked connected.
  if (res.connected) return { result: "active" };

  const redirectUrl = res.redirectUrl ?? null;
  const account = res.connectedAccountId ?? "";
  if (!redirectUrl || !account) return { result: "failed" };

  const popup =
    typeof window !== "undefined" ? window.open(redirectUrl, "flowlet-connect", POPUP_FEATURES) : null;
  if (!popup) return { result: "needs-auth", redirectUrl };

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await wait(POLL_MS);
    const status = await pollStatus(toolkit, account);
    if (status === "active") {
      popup.close();
      return { result: "active" };
    }
    if (status === "failed") {
      popup.close();
      return { result: "failed" };
    }
    if (popup.closed) {
      // User closed the window — do one final status check before giving up.
      const final = await pollStatus(toolkit, account);
      return { result: final === "active" ? "active" : "failed" };
    }
  }
  popup.close();
  return { result: "timeout" };
}
