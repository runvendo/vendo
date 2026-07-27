---
"@vendoai/apps": patch
"@vendoai/actions": minor
---

Generation repair now repoints an array-expecting prop that landed on a `{ data: [...] }` wrapper object, instead of regenerating the whole app. Live on the Maple demo, the most obvious prompt ("Show my spending by category") never rendered: the model bound the donut's `slices` array prop to the spending tool's ROOT object, validation correctly rejected it (`expected an array, the bound field is object`), and — because a kind mismatch is not a compile *binding* error — structured repair's closed fix space was empty, so every attempt paid a full-lane regeneration. When the bound object holds exactly ONE top-level array, repair now derives the nested path and splices it with no model call; ambiguous shapes (zero or 2+ arrays) keep today's behavior. Any host returning an envelope instead of a bare array hit this.

`vendo sync` also records a host's DECLARED response body: an OpenAPI 2xx `application/json` schema becomes `outputSchema` on the `.vendo/tools.json` entry (refs resolved), so the envelope a host returns is part of the committed contract rather than something the model infers. Nothing is invented when the spec is silent.
