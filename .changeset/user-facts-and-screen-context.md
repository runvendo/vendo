---
"@vendoai/ui": major
"@vendoai/vendo": major
"@vendoai/agent": minor
"@vendoai/agents": minor
"@vendoai/harnesses": minor
"@vendoai/apps": minor
---

The agent can now be told who the user is and what they are looking at.

Two seams, both optional, both merged into one `[Situation]` block on every
message the user sends:

- **User facts.** The `user` resolver on the `authJs()` and `jwt()` auth presets
  may now return a `facts` object alongside the principal, and those facts reach
  the prompt. The session is decoded once per request for both the principal and
  the facts. An anonymous request resolves no facts.
- **Live screen context.** `useVendoContext(data)` publishes structured host data
  for as long as the component is mounted, and retires it on unmount. Several
  mounted callers coexist and merge. `VendoProvider` also takes `captureScreen`
  (default `true`) to control the screen snapshot that rides the same channel.

**BREAKING (`@vendoai/ui`, `@vendoai/vendo/react`): `useVendoContext` is now
`useVendoProvider`.** The name `useVendoContext` previously belonged to the
zero-argument hook that read everything `VendoProvider` supplies; it now belongs
to the host-facing hook above, which takes data and returns nothing. Both names
still exist, so the compiler is the thing that catches this:

```diff
- const { client } = useVendoContext();
+ const { client } = useVendoProvider();
```

Because both names still exist, the compiler catches this rather than the
runtime: an existing zero-argument call now fails with `TS2554: Expected 1
arguments, but got 0`. Rename the call and you are done — nothing else about the
provider value changed.
