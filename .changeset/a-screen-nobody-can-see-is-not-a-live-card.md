---
"@vendoai/vendo": patch
"@vendoai/harnesses": patch
---

A run whose LAST save never reached the screen stops answering "your card is live".

A screen build saves as it goes, and the run kept two different facts about those saves: `assembled`, which means bytes reached the store at least ONCE and is never unset, and `painted`, which means the LAST save reached the person's screen. The outcome was gated on the first of them. So a build whose early save cleared the checks floor and whose last one did not still answered "assembled" — and because the earlier paint had left a row, the front door found it, stamped the receipt `ready`, and spoke the model's own closing words over a card that was stale or half-written. The field case read "Your card is live!" over an empty one.

`painted` is a three-state fact now — painted, refused, or nobody judged (an unwrapped workspace claims nothing) — and the outcome is gated on it: a run whose last save the floor refused is `unavailable`, carrying the floor's own sentences, on the same carrier a deployment-level refusal already travels. The person is told what is wrong with the screen they asked for, and MCP callers stop hearing the generic "produced nothing renderable" on an ordinary refusal. A run whose last save painted is unchanged, the reviewer's repair round included: the screen it repairs has already painted, and whatever survives it still stands.

Also: four `catch {}` blocks that swallowed the cause whole — the BYO tool pack's execute and delegate, and the harness tool bridge's and turn tools' — now say what threw, to the host's log. The wire keeps its generic sentence, because raw internals are not the model's business; a `VendoError` from a host tool was written FOR the model, so the pack and the bridge forward its own code and message rather than masking "list them first" behind "Tool execution failed."
