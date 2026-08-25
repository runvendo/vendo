---
"@vendoai/mcp": minor
"@vendoai/vendo": minor
---

The MCP door speaks the built-app world an outside agent now meets.

A SEALED bundle is the app, and it is not a page: it boots inside the host's own
UI, in a sandboxed frame whose only way out is the host's postMessage bridge. So
`vendo_apps_open` answers a bundle with the open-in-product card an app with a
url of its own already took — the product's name and the deployment's public url,
"Open Spending in Maple: https://…" — and a deployment that named no public url
still says the app is built and ready rather than handing back a content hash,
which was the whole of the previous answer.

The two build-window waits stop arriving as failures. An app whose build the
person has not approved, and one still being built, both refuse an open with a
not-found; the door names them ("waiting on the user's build approval", "still
being built") on every leg it serves — its own apps path and the one the bound
registry owns — so an agent narrates the wait instead of telling someone their
app is gone. A build that failed for good comes back as its reason, plus whether
asking again may work, instead of a JSON record to paraphrase. Each answer still
rides as `structuredContent` under its own `kind`, so a loop reads the state
rather than the English.

The umbrella's door port stops narrowing what an open may answer: it forwarded
trees and http surfaces and threw "this is a server app resuming in-product" at
everything else — a rung that no longer exists.
