---
"@vendoai/vendo": minor
"@vendoai/store": patch
"@vendoai/core": patch
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

The erase cascade learned one new thing to make that whole. `vendo_secrets` sat
outside every selector for a stated reason — its rows were name-keyed HOST
config, which no subject could reach — and a tenant connector's vault name
breaks that premise by carrying the org that owns it. So erasing an org now
takes its connector tokens with its registrations, and nothing else: a
deployment's own `API_TOKEN` still belongs to the deployment, not to any person.
One name builder in `@vendoai/core` serves both the write side and the sweep, so
they cannot drift.

`vendo doctor` gains `E-TENANT-001`: a host whose source reaches
`vendo.tenantConnectors` with no `VENDO_STORE_ENCRYPTION_KEY` and no
`VENDO_API_KEY` is warned that a pasted token is stored in the clear locally and
refused outright in production — a failure that would otherwise only appear on
the first credentialed registration after a deploy. Static, like every other
doctor check: a source marker and two env names, no store opened and no tenant
server dialled.
