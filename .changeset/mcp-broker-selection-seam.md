---
"@vendoai/vendo": minor
---

A keyed host's MCP door now fronts itself with the hosted broker — zero config.

**The broker default (adapter rule).** With `mcp` enabled, `VENDO_API_KEY` set,
and a public `VENDO_BASE_URL`, composition ensures a broker tenant at
`{slug}.mcp.vendo.run` through your Vendo Cloud console and wires the door's
`remoteAs` + `federation` from the response — the same way the key already
fills the store, sandbox, inference and connections slots. An explicit
`mcp.remoteAs` in config still wins verbatim, and a host with no key (or no
public URL — localhost, `*.local`, and private addresses can't be fronted by
the broker) keeps today's local door byte-for-byte. The ensure call is
idempotent and rides the boot-once ready latch, so composition stays I/O-free
at module init (Workers-safe); if the console blips at boot, the door falls
back to its own local OAuth surface with one loud warning instead of dying.

**`/status` says which door composed.** `blocks.mcp` is now a posture —
`"local"`, `"broker"`, or `false` — following the `blocks.connections`
pattern. Older clients that only checked truthiness keep working.

**Doctor explains the silent cases.** A key + an open door + no public base
URL prints the new `I-CLOUD-002` informational ("the hosted MCP broker
activates when the deployment has a public base URL"); with a public URL,
doctor resolves and prints the tenant your door composes against.
