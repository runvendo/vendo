---
"@vendoai/vendo": patch
---

fix: allowlist the extraction child-process environment so untrusted repo dotenv/npmrc can't inject code or redirect credentials

`vendo sync` builds the environment for the coding-agent children it spawns
(`npm`, `claude`, `codex`) by merging the repo's own `.env`/`.env.local`. A
cloned repo could therefore set `npm_config_registry` or `NODE_OPTIONS` to run
arbitrary code in those children, or `VENDO_CLOUD_URL`/`ANTHROPIC_BASE_URL` to
redirect the Cloud key and the source-bearing prompts to an attacker endpoint.
The extraction path now reads the dotenv through an allowlist — a repo file may
contribute a credential, the model pin, or the dev-server URL, and nothing else;
every other variable reaches a child only from the developer's own shell, never
from the checkout. (Doctor's config reads keep the general reader unchanged.) The
npx rung also pins its registry on the child (from the developer's own shell
value, else the public default), so a repo-root `.npmrc` — which `npm exec` reads
from cwd and which outranks the user's own `~/.npmrc` — can no longer redirect
the engine fetch to a malicious registry. The Agent SDK availability probe no
longer imports the host-resolved module just to check that it exists.
