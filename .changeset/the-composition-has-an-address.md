---
"@vendoai/vendo": patch
---

The composition has an address, and doctor knows what the install is for.

`vendo init` now writes the Next composition to its own module — `lib/vendo.ts`
(`src/lib/` when the app directory is under `src/`) — exporting `vendo`, with
the wire route a thin `nextVendoHandler` over it. Every docs page and every
snippet init prints already said `import { vendo } from "@/lib/vendo"`; that
file finally exists, so an agent loop, a backend job and the origin-root
discovery route can all reach the SAME instance instead of composing a second
wire that shares none of the first one's state. The specifier is the `@/` alias
where the host declares one and a relative path otherwise, so the generated
route compiles either way; the MCP path now opens its door in that one module
rather than a second one beside the route, and the registration map follows the
composition it is imported from. Existing installs are untouched — init only
ever creates files, and doctor grades both shapes.

Init records the resolved use case in `.vendo/install.json`, and doctor reads
it: an agent-loop or MCP install mounts no Vendo UI by design, so E-WIRE-004
and E-WIRE-006 no longer fail a host that is correct by construction — doctor
says which checks it skipped and why. An unattended re-run keeps the recorded
answer instead of falling back to embedded.

A missing model credential is a visible warning now (E-MODEL-001) instead of a
note `--json` swallowed, so an agent stops reading "green" on a host that
cannot answer a single turn. Doctor still exits 0: production keys live where
it cannot read them.

Also: the models question offers "I already have a Vendo key — paste it", so a
dev with a key stops minting a second one; `.env.example` names the host's own
dev port instead of always `:3000`, and says out loud that an agent loop and any
backend process need `VENDO_BASE_URL` even in dev; and every fix-it text that
reaches a non-interactive audience names `vendo sync --ai`, the spelling that
actually grades without a consent prompt nobody is there to answer.
