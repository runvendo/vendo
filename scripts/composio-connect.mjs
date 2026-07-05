/**
 * Connect (or re-connect) the demo's Gmail + Slack accounts via Composio.
 *
 * Run with COMPOSIO_API_KEY set in your environment:
 *   pnpm composio:connect
 *
 * Prints the current connection status for userId `vendo-demo`. For any
 * toolkit not yet ACTIVE, it initiates a connection and prints an authorize URL
 * to open in a browser. Already-connected toolkits are reported and skipped.
 */
const USER_ID = "vendo-demo";
const TARGETS = [
  {
    name: "GMAIL",
    authConfigId: process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID ?? "ac_C0WWr2sbI7AV",
  },
  {
    name: "SLACK",
    authConfigId: process.env.COMPOSIO_SLACK_AUTH_CONFIG_ID ?? "ac_DT5-sR-LyeGz",
  },
];

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) {
  console.error("COMPOSIO_API_KEY not set - set COMPOSIO_API_KEY in your environment.");
  process.exit(1);
}

const API = "https://backend.composio.dev/api/v3";

async function listConnections() {
  const res = await fetch(`${API}/connected_accounts?user_ids=${USER_ID}`, {
    headers: { "x-api-key": apiKey },
  });
  const json = await res.json();
  return json.items ?? [];
}

async function initiate(authConfigId) {
  const res = await fetch(`${API}/connected_accounts`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      auth_config: { id: authConfigId },
      connection: { user_id: USER_ID },
    }),
  });
  return res.json();
}

const existing = await listConnections();
console.log(`Connections for ${USER_ID}: ${existing.length}`);

for (const t of TARGETS) {
  const match = existing.find(
    (c) => (c.toolkit?.slug ?? "").toLowerCase() === t.name.toLowerCase(),
  );
  if (match && match.status === "ACTIVE") {
    console.log(`  ✓ ${t.name} — ACTIVE (${match.id})`);
    continue;
  }
  const created = await initiate(t.authConfigId);
  const url = created?.connectionData?.val?.redirectUrl ?? created?.redirect_url ?? null;
  console.log(`  → ${t.name} — open to authorize: ${url ?? "(no redirect; check Composio dashboard)"}`);
}
