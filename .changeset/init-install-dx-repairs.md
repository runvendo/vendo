---
"@vendoai/vendo": patch
---

`vendo init` stops deciding things for you in silence, and the install it leaves
behind can compile what it wrote.

A run that cannot ask no longer answers. Piped stdin and CI used to settle the
use case doctor grades against, the auth the agent acts as, the model story and
the dev origin, then print the same success frame an attended install prints —
so nothing said a decision had been made and the first sign was a tool call
failing days later. Such a run now prints the defaults it would take, each
naming the flag that answers it, and exits non-zero; `--yes` proceeds and still
says what it settled.

`--agent` grades. Judgment was "delegated to you" on the grounds that the caller
is a model, but the pass is a scripted engine run with a verbatim quote behind
every proposal and an independent skeptic over each one, so every agent install
shipped a catalog whose every tool asked on each call. It now runs the pass with
whatever engine resolves, asking nothing; with no engine on the machine at all
the receipt hands the checklist back as REQUIRED work and says so out loud.

The use-case question reads the evidence the scanner already had: a host whose
own API runs an agent loop gets "through your own agent loop" recommended, with
the route named, in both the interactive select and the `--agent` question form.
The `--agent` auth question gained the same detection interactive mode has, so
`none` is recommended — and says why — when no auth dependency is there.

Repairs to the rest of the install:

- A re-run over an existing composition no longer refuses the MCP door with
  "wire an auth preset". Init never re-decides auth for a file it did not write,
  so the file itself is read instead.
- `VENDO_SERVICE_KEY` is reused when the host already has a well-formed one,
  instead of being reminted and written over the key every backend caller was
  already exchanging.
- Every package the generated files import is now a declared host dependency:
  the backend path's docs never install `@vendoai/vendo`, so a host following
  them got a `lib/vendo.ts` importing a package its build could not resolve.
- `VENDO_BASE_URL` reaches `.env.local` from any attended terminal. The question
  borrowed the run-wide interactivity flag, which folds in "a package script
  launched this" — and npm sets that for every `npm run …` — so the same person
  in the same terminal was asked by `npx vendo init` and not asked at all
  through a wrapper script.
- No `<VendoProvider>` / `<VendoOverlay>` paste for an agent-loop or MCP
  install, which mount no Vendo UI by design (the rule doctor already grades by).
- The agent-loop snippets compile as printed: they declare the `principal` they
  pass — resolved from the preset the composition wires, or the same anonymous
  literal the composition resolves — name the host's real chat-route path under
  `src/`, and name the Mastra agent file the host actually has.
- Five stale docs URLs, and a test that maps every docs.vendo.run URL the CLI
  can print to a file under `docs-site/`. Doctor's `fix_ref` now lands on the
  code's own troubleshooting page instead of a retired playbook with the code in
  a fragment the server never sees.
- The judgment receipt names the file the grades landed in and the merge that
  keeps `tools.json` saying `ungraded` — three auditors read the old receipt and
  concluded the pass had done nothing — and tells you to restart the dev server,
  which read the judgments once, at boot.
- `vendo ready` and the hosted-store notice are latched per PROCESS, not per
  module. Next's dev server re-instantiates the module graph, so both came back
  every couple of seconds and flooded the log.
