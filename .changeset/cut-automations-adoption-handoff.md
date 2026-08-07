---
"@vendoai/automations": minor
"@vendoai/core": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

The automations adoption handoff is removed. When an automation's sponsorship
lapsed — the sponsor left, lost their permissions, or somebody else edited the
app — the automation stopped and an "adoption card" waited inside the app so the
next editor could take it on, re-approving its reads and writes as themselves.
No host used it.

Sponsorship itself is unchanged: an automation still runs as a named person, and
still stops when that person's authority lapses. What goes is the second half —
the handoff to somebody new.

Gone: `AutomationsEngine.adoption()` and `.adopt()`, the `AdoptionCard` and
`AdoptionNeed` types (`@vendoai/automations`); `ADOPTION_VENUE_KEY`
(`@vendoai/core`); `POST /automations/:id/adopt/:triggerId` (`@vendoai/vendo`);
`client.automations.adopt()`, `<AdoptionCard>`, `<AdoptionVenueCard>`,
`ADOPTION_VENUE_KEY`, `AdoptionCardProps`, `AdoptionVenue` and `AdoptResult`
(`@vendoai/ui`).

Pre-1.0 hard cut, no deprecation shim. A stopped automation is restarted the way
it was armed in the first place: anyone who can edit the app calls `enable()`
again, which re-approves its reads and writes under the new sponsor. The stopped
sentence the run row and the list carry now says "anyone who can edit this app
can turn it back on" instead of "…can take it on".
