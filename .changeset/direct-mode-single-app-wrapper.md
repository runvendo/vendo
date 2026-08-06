---
"@vendoai/apps": patch
---

Follow-up to #823: with the JS-idiom mistakes gone, "expected a single <App
...>...</App> element" became the dominant direct-mode failure — the model's
answer wasn't wrapped in exactly one root `<App>` element. `brainPrompt` now
states that rule explicitly, quoting the wire compiler's own error text, and
the direct-mode retry loop's own instruction repeats it for the retry
specifically. This failure was already reaching `conductCreate`'s #823 retry
loop like any other compile issue (confirmed by test) — the gap was purely
that nothing taught the model the rule in the first place.
