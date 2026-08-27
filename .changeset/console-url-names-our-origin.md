---
"@vendoai/core": minor
"@vendoai/agents": minor
"@vendoai/apps": minor
"@vendoai/harnesses": minor
"@vendoai/vendo": minor
---

`VENDO_CONSOLE_URL` names our origin; `VENDO_BASE_URL` names yours.

Vendo shipped four look-alike "a URL" environment variables, two of which landed
in the same generated code block on the edge-runtimes page:

```ts
const apiKey = env.VENDO_API_KEY;
const baseUrl = (env.VENDO_CLOUD_URL ?? "https://console.vendo.run").replace(/\/+$/, "");
```

`VENDO_BASE_URL` is the host app's own public URL. `VENDO_CLOUD_URL` read like
"the URL of my cloud deployment" — which is exactly what it is not. Point it at
your app and every Cloud adapter quietly calls your app instead of the console.

`VENDO_CLOUD_URL` is now `VENDO_CONSOLE_URL`. Nothing breaks: the old name is
still read, the new one wins when both are set, and the first read of the old one
logs a single line naming the new one. The generated Workers/Bun/Deno scaffold
spells the value `consoleUrl` rather than `baseUrl`, so the two URLs no longer
look alike where they sit side by side.

`VENDO_URL` is retired. It overrode the wire URL `vendo sync` probes — a job
`vendo sync --url` already does per run, and one `VENDO_BASE_URL` already derives.
It is still read, and `vendo sync` says so once when it is.

`VENDO_BASE_URL` and `VENDO_HOST_API_URL` are unchanged. Renaming either would
churn every deployment for no gain: one is the most-typed variable Vendo has, the
other already says what it is.

`@vendoai/core` exports `consoleUrlFromEnv(env?)`, the single reader every block
now shares instead of six copies of `process.env["VENDO_CLOUD_URL"]`. Two of
those copies took a blank value literally and passed `baseUrl: ""` down to the
adapter; every reader now treats blank as unset, the way the umbrella always did.
