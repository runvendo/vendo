---
"@vendoai/vendo": patch
---

`vendo init`'s MCP arm stops asking how outside agents sign in. That was never
one answer: the dev machine wants the door's own OAuth (it works on `http`, zero
config) and the deployment wants the Cloud broker — and nobody knows their
deployment while they are installing.

A Cloud key settles both. With one in hand init asks nothing at all: it writes
the dev sign-in key into `.env.local`, which is dev-only and gitignored, so the
machine keeps its own door while the deployment — which never sees that variable
— takes the broker, and the run closes on one line saying so. With no key it
asks once, in the models question's slot rather than beside it, because one free
Cloud key answers both: *Vendo Cloud (recommended) or bring your own keys?*
Choosing Cloud runs the `vendo login` ceremony inline; a login that does not
complete prints one line and finishes the install on the bring-your-own path.
`--yes` never opens a browser, and `--agent` relays the one question as JSON.

`--posture` and `--service-key` still do exactly what they did, as flags, for a
host that wants a Cloud-fronted door and no sign-in key on its dev machine.

New `vendo doctor` warning **E-MCP-010**: a `VENDO_SERVICE_KEY` set alongside a
Cloud key on an https deployment holds the door local against the broker that
key already provisions. Advisory, not a failure — running your own door there is
a legitimate choice.
