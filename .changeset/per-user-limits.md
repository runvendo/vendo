---
"@vendoai/core": minor
"@vendoai/harnesses": minor
"@vendoai/store": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

Per-user limits: Vendo counts, the host decides.

`createVendo({ limits })` takes one callback, asked once before each metered
action — a user message, an app generation — with the resolved user, the action,
and a `count(action, window?)` reader already bound to THAT user. Return `false`,
or `{ allow: false, message }` to say why in your own words, and the action is
refused and never counted; anything else allows it and the meter records it.

```ts
createVendo({
  limits: async ({ user, action, count }) =>
    user.facts?.plan === "pro" || await count(action, { days: 1 }) < 20,
});
```

`count` is a callback and not a number because most policies read the meter
once, for one window, and pre-computing every window a policy might ask about
would be a query per action per call. `window` ANDs `days`/`hours`/`minutes`
into one lookback, or takes a `since` instant, or names a `pool`.

**Pools** are the shared meters a user's usage ALSO counts into — a seat pool, a
team, an org. The auth preset grows a `pools` seam beside `facts`, resolved off
the same session decode, and its answer rides `ctx.pools` to the policy;
`count(action, { pool: "workspace" })` then counts the whole bucket rather than
the one person, and an allow accrues to every pool the user is in. Counting a
pool the user is NOT in throws rather than answering `0` — a zero from a meter
that was never resolved silently under-counts every limit written against it.

**A denied message costs nothing.** The message choke sits at turn entry, before
the thread is resolved, so a refused message performs no read, no write and no
model call. The turn's whole response is the limit card.

**A denied generation lets the turn carry on.** The generation choke wraps
`vendo_make`, the one door an app is built through, and answers the agent with
the same `blocked` outcome every other refusal on that registry uses — so the
agent can say what happened in its own words — while raising the card the person
reads on the call's own stream.

A refusal nobody was asked about — a limit, a guard rule, an unattended park, a
guard that could not run its check — now settles on the wire as that typed
`blocked` outcome rather than as the ai-SDK's `output-denied`. That state is the
terminal state of an approval a PERSON turned down: its provider conversion takes
the refusal's words off the part's `approval`, so a refusal that has none used to
write history that could not be sent again, and the thread died on the turn after
one — including an unattended thread whose call is waiting on a standing grant.
The refusal's own words are now kept in the record too, and the beat says who
refused: "wasn't allowed", not "you declined it". A person's actual no is
unchanged, and is the only thing `output-denied` now means.

Both raise `data-vendo-limit`, and the chat surface renders it as a card in the
beat's ordinary muted register: a cap reached is not a failure, so no ✕, no
danger colour, and a polite `status` rather than an `alert`. The host's own
sentence is what the person reads when the policy wrote one — the host set the
cap, so only the host can say what it is or when it lifts — and a policy that
said nothing gets the chrome's line, which claims only that the request never
ran.

**A policy that throws DENIES**, and logs `limits.callback_error`. A limits
system that fails open stops limiting silently, so the host keeps believing they
have a cap while every user is unlimited — strictly worse than a turn that was
refused and said so.

**A `limits` policy against a store with no usage meter is refused at
composition.** `StoreOps.usage` is optional, and a store that cannot count reads
every user as zero, so no limit would ever be reached and every user would be
unlimited. It throws where the deployment is built rather than enforcing against
counts that are all zero.

`vendo.usage(query)` is the operator's read of the same meter — per subject and
action, over one window — for a host's own backend job: an overage sweep, a
usage table. A policy never uses it; a policy asks its own bound `count` and
never names a subject. On a meterless store it refuses for the same reason
`emit` does, because a billing sweep reading "no usage" would bill nobody.

Unset, `limits` wires nothing: no limiter is composed, the tool registry is the
same object it always was, and each choke point costs one `undefined` check.
