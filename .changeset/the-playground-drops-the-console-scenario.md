---
"@vendoai/vendo": patch
---

The playground's `page` scenario is replaced by the two panels a host still mounts itself.

`VendoPage` is being cut, so the scenario that mounted it (`#page`, "Workspace
console") goes with it. What it uniquely showed that no other scenario did was
the automations list and the connected-accounts settings, so those become
scenarios of their own against the same fake wire client: `#automations-panel`
(`AutomationsPanel`) joins the Automations group, and `#accounts`
(`ConnectedAccountsPanel`) opens a new Accounts group. The `Page` group is gone.

Breaking for `mountScenario`/`VendoDocsEmbed.mount` callers: `scenario: "page"`
now throws `unknown scenario`. The console shell itself — the conversation-history
rail, the app shelf, and the Apps door — is no longer demonstrated anywhere,
because it is no longer shipped.
