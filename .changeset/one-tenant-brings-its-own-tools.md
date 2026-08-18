---
"@vendoai/vendo": minor
---

One tenant brings its own tools, and only that tenant's users get them.

A customer with its own MCP server or OpenAPI spec had one way in: you add the
connector to `createVendo({ connectors })` and redeploy — and then every tenant
on the deployment has it, because there was only ever one tool registry.

`vendo.tenantConnectors` is the dev-side API that ends that. `register` takes an
org, an MCP URL or an OpenAPI spec, and the token the customer pasted; it
validates by ACTUALLY CONNECTING and answers with the tools the server really
advertised, or a typed error. `list`, `test` and `remove` are the rest of the
admin screen you were going to build anyway. There is no Vendo-hosted UI here,
and no console step: the surface is yours.

Visibility follows the orgs your host already asserts (`memberships`), and it is
STRUCTURAL. A run that asserts `acme` is served the shared registry plus Acme's
own; a run that asserts `globex` is served a registry Acme's connector was never
in. There is no filter over a combined set, so there is no filter to get wrong.

Registrations ride the generic records collection — no store schema change, no
migration — stamped with the org that owns them, so the existing erase cascade
reaches them like every other row that names a subject. The pasted token never
lands in a row: it is vaulted in the store's encrypted secrets under a
tenant-scoped name, and no public surface reads it back.
