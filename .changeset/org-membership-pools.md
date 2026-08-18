---
"@vendoai/vendo": minor
"@vendoai/core": patch
---

An org the host already asserts is a usage pool, with nothing wired for it. A
host that answers `memberships` for a request — the same assertion app grants
are matched against — now gets one pool per org, named and keyed `org:<orgId>`
by core's own principal encoding, so a limits policy can cap a whole team the
day it can name one:

```ts
limits: async ({ count }) =>
  (await count("message", { days: 30, pool: "org:maple" })) < 200,
```

One grammar, not two: the string a policy counts is the string a grant names
that org by. Teams stay out of it — a team is a slice of an org's allowance, not
a bucket the host asked to meter. A pool the host asserts itself still wins on a
name collision, so metering an org by the host's own key keeps working, and a
policy naming an org nobody asserted still fails closed rather than reading
zero. Maple demonstrates it: the branch shares 200 messages a month, on top of a
per-person daily cap.
