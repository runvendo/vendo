---
"@vendoai/harnesses": patch
---

A tool call the model emitted as broken JSON now costs the turn one step instead
of killing it.

When a tool call's input text does not parse — malformed JSON, or a generation
truncated at `max_tokens` mid-object — the AI SDK keeps the RAW STRING as that
call's input, marks the call invalid, enqueues a `tool-error` as its output, and
carries on. That string then rides into the assistant message appended to the
running prompt, and on the very next step the Anthropic provider serializes it
verbatim as `tool_use.input`. The provider rejects the whole request —
`tool_use.input: Input should be an object` — so a single bad call took the
entire turn down, several steps of real work with it. Seen live on Cloud managed
inference.

The turn loop's `prepareStep` now normalizes every outgoing prompt: any
`tool-call` part whose input is not an object is sent as `{}`. That is the one
seam that sees every step, so it covers the projected history, the SDK's in-turn
accumulation and the overflow retry's resume path alike. Nothing is lost — the
paired tool result already carries the invalid-input error, so the model simply
re-issues the call with real arguments. Tool results are never rewritten, and a
prompt with no broken call is passed through untouched.
