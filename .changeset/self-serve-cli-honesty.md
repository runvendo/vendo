---
"@vendoai/vendo": minor
---

Seven self-serve fixes across the CLI: the install path stops lying, and the JS
scaffolds run.

**Plain-JavaScript hosts boot again.** The generated `vendo/server.mjs` carried
two pieces of TypeScript — `kind: "user" as const` in the principal line and a
`as Headers & { … }` cast around `getSetCookie` — so every Express, bare-Node
and `--framework custom` host on a JS codebase died with `SyntaxError:
Unexpected identifier 'as'` on its first `node server.js`. Both expressions now
follow the host's language, and Node's own parser gates them in CI.

**`vendo doctor` names a stale install.** npm release-cooldown configs
(`min-release-age`) silently resolve an old `@vendoai/vendo`, and nothing ever
said so. Doctor now checks npm's `latest` and prints `warning: installed
@vendoai/vendo X is behind latest Y` with the upgrade command. Fail-soft: an
offline, blocked or slow registry says nothing at all and never changes the
exit code.

**Two silent CI failures are loud.** `vendo mcp server-json` with missing flags
used to fall into a readline prompt even on a piped stdin — a script or agent
hung forever; it now exits 1 naming `--domain` and `--url`. `vendo sync
--report` without a Cloud key used to complain and exit 0, so a reporting lane
stayed green while never reporting; it now exits 1.

**`vendo try` is unlisted.** The command still runs for anyone invoking it, but
help no longer advertises it (nor do the retired `playground`/`refine`
notices): the pre-install `npx vendo try` pitch it fronted resolves no npm
package.

**Init's ending puts the paste last.** The run's final line is the outstanding
paste, on interactive and non-interactive runs alike, instead of the star ask
or the agent tail; the "start your dev server — the agent is live in your app"
line is withheld while a paste is still pending (it contradicted the frame
right above it); and the keyless Cloud pitch is three lines, since `vendo
login` narrates its own ceremony.

**Quieter dev-server logs.** The hosted-store automations notice is latched per
process — a Next dev server recomposes on nearly every request, and the
paragraph was landing in the host's log dozens of times per session.
