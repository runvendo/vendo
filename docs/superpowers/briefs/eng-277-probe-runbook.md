# ENG-277 jail probe runbook

This fixture exposes two MCP endpoints from one process:

| Leg | Connector URL | What it proves |
| --- | --- | --- |
| Standalone capability probe | `https://<quick-tunnel-host>/probe/mcp` | The client iframe's eval, nested `srcdoc`, `postMessage`, and inherited-CSP capabilities, independently of Vendo's shim. |
| Real Vendo door | `https://<quick-tunnel-host>/api/vendo/mcp` | OAuth plus the production MCP Apps shim rendering a generated component through `JailedComponent`'s two nested `srcdoc` frames. |

Use two connector/app entries when testing both legs. A Cloudflare Quick Tunnel hostname is ephemeral; if the tunnel restarts, replace `<quick-tunnel-host>` with the new `*.trycloudflare.com` hostname and recreate or update the client entries.

## Start the stack and tunnel

From the repository root, start the stack and leave it running:

```bash
PORT=3210 pnpm --filter @vendoai-fixtures/mcp-e2e probe:serve
```

Expected output includes the two local endpoints and the fixture credentials. In a second terminal, start the tunnel and leave it running:

```bash
npx -y cloudflared tunnel --url http://127.0.0.1:3210 --no-autoupdate
```

The `cloudflared` npm wrapper downloads Cloudflare's platform binary on first use. Copy the `https://<random-words>.trycloudflare.com` URL from its output; that URL is the public origin used below.

Verify the public health endpoint and the real door's OAuth discovery before adding either client:

```bash
export PROBE_ORIGIN=https://<quick-tunnel-host>
curl --fail --silent --show-error "$PROBE_ORIGIN/healthz"
curl --fail --silent --show-error \
  "$PROBE_ORIGIN/.well-known/oauth-protected-resource/api/vendo/mcp"
curl --fail --silent --show-error \
  "$PROBE_ORIGIN/.well-known/oauth-authorization-server/api/vendo/mcp"
```

Every absolute URL in the two metadata documents must begin with `$PROBE_ORIGIN`, never `http://127.0.0.1:3210`. The bridge honors `X-Forwarded-Host` and `X-Forwarded-Proto`; `PROBE_PUBLIC_ORIGIN=https://...` is also available as an explicit origin override if a different tunnel does not forward those headers correctly.

## OAuth login and consent

The standalone capability endpoint has no authentication. The real Vendo endpoint performs the complete OAuth 2.1 flow:

1. Let Claude or ChatGPT open the authorization page after connector creation or tool scanning.
2. On **Sign in to the ENG-277 probe**, enter username `probe` and password `jail`, then select **Sign in**.
3. On **Allow <client>?**, inspect the requested scopes and select **Allow connector**.
4. The browser returns the authorization code to the client, which completes PKCE token exchange automatically.

This fixture account and its temporary store exist only while the stack process is running.

## Claude.ai

Anthropic's current custom-connector instructions are at [Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

For an individual plan:

1. Open Claude on the web and go to **Customize → Connectors**.
2. Select **+ → Add custom connector**.
3. Name the entry `ENG-277 capability probe` and enter `https://<quick-tunnel-host>/probe/mcp`. Leave advanced OAuth client credentials empty, then select **Add**.
4. Repeat with the name `ENG-277 real Vendo jail` and URL `https://<quick-tunnel-host>/api/vendo/mcp`.
5. Select **Connect** on the real Vendo entry and complete the fixture login and consent steps above.
6. In a new conversation, select **+ → Connectors** and enable the entry being tested.

On Team or Enterprise, an Owner first uses **Organization settings → Connectors → Add → Custom → Web** for each URL; a member then uses **Customize → Connectors → Connect**. Test one endpoint at a time so the intended tool choice is unambiguous.

## ChatGPT developer mode

OpenAI's current setup instructions are at [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta).

1. Use ChatGPT on the web and confirm developer-mode access. An authorized Enterprise/Edu user enables it under **Settings → Apps → Advanced Settings**; a Business admin/owner can enable it while creating an app under **Workspace settings → Apps → Create**.
2. Go to **Settings → Apps → Create** (or **Workspace settings → Apps → Create** for an admin/owner).
3. Create `ENG-277 capability probe` with endpoint `https://<quick-tunnel-host>/probe/mcp` and no authentication. Select **Scan Tools**, wait for `vendo_jail_probe`, then select **Create**.
4. Repeat for `ENG-277 real Vendo jail` with endpoint `https://<quick-tunnel-host>/api/vendo/mcp` and OAuth authentication. Select **Scan Tools**, complete fixture login and consent when prompted, wait for the scan, then select **Create**.
5. Open a new chat and select the draft app from the tools menu (it has a **Dev** label), or mention it in the prompt. Test one app at a time.

ChatGPT snapshots tool definitions during app approval. If the tunnel hostname or tool definitions change, recreate the draft app rather than trusting the cached scan.

## Run the probes

### Standalone capability probe

With the capability entry enabled, prompt:

> Call `vendo_jail_probe` exactly once and show its interactive app. Do not replace the app verdict with a text-only summary.

The rendered app has six large rows:

- `eval-direct`: **PASS** means `eval("1+1")` worked in the client app iframe. **FAIL** preserves the thrown CSP/browser message.
- `new-function`: **PASS** means `new Function("return 1")()` worked in the client app iframe.
- `srcdoc-1`: **PASS** means the first `sandbox="allow-scripts"` `srcdoc` frame ran and posted to the app frame.
- `srcdoc-2`: **PASS** means the second nested `srcdoc` frame ran and its report reached the app frame.
- `postMessage cross-nesting`: **PASS** means the level-2 report crossed level 2 → level 1 → app frame.
- `eval-in-jail`: **PASS** means `new Function` worked inside the innermost `srcdoc` document. This is the decisive inherited-CSP result for Vendo's generated-component jail.

The facts panel also displays `document.baseURI`. If the browser emits `securitypolicyviolation`, **Observed CSP violation policies** shows the frame, effective directive, and `originalPolicy`; otherwise it explicitly says that no violation event was observed. A nested result left unanswered for five seconds becomes **FAIL** with a timeout detail.

Capture a screenshot containing all six rows and the facts panel for each client.

### Real generated-component jail

With the real Vendo entry enabled, prompt:

> Call `vendo_apps_list`, then call `vendo_apps_open` with `appId` `app_jail_probe`. Show the interactive app and do not substitute a text-only summary.

Success is a green-bordered card headed **REAL VENDO JAIL: PASS**. Select **Exercise jailed React** and verify **Jail interactions: 1** appears. This proves the real shim routed generated TSX through the production two-frame jail, compiled/executed it, rendered React, and carried a browser interaction.

If the standalone rows pass but this card does not render, record the client console/error and treat it as a Vendo shim/jail pipeline failure rather than a host CSP result. If `eval-in-jail` fails with a `script-src`/unsafe-eval message, the client sandbox blocks the jail's current `new Function` execution path even if the outer shim and primitive tree apps still work.

## Local regression check

This checks both MCP registration shapes, full OAuth on the real door, real shim loading, generated-component rendering, and the jailed button interaction in headless Chromium:

```bash
pnpm --filter @vendoai-fixtures/mcp-e2e typecheck
pnpm --filter @vendoai-fixtures/mcp-e2e probe:smoke
```
