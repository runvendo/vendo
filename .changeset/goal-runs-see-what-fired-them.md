---
"@vendoai/automations": minor
---

A goal automation can see what fired it. The runner was handed
`record.task.prompt` and nothing else, so the delivery body behind a webhook
automation — and the payload of a `vendo.emit` — was persisted on the run row as
`__event`, was re-fired verbatim by `runs.rerun`, and was never shown to the
agent at all. A steps task reads the firing through its own expressions; a goal
task had no way to, which made "when this webhook lands, deal with THIS invoice"
impossible to write.

The payload now rides the prompt, under a label that says what it is: data from
the outside event, never more of the instruction. It is serialized with
`JSON.stringify`, which escapes every newline in it, so the whole of somebody
else's document stays on the one line under that label and cannot open a section
of its own; past 16 KiB it is cut and the block says how much it cut. The change
is at the engine, so every registered runner gets it. A schedule fires on the
clock the tick wrote and nothing else, so its prompt is byte for byte what the
author typed.

The label is a request, and a request is not a security boundary. Nothing here
treats it as one: a new full-stack suite sends a real signed delivery whose body
orders a destructive host tool, runs it through a harness that reads the tool
name out of the payload and obeys it, and pins that the call is never on an away
listing, never executes, and changes nothing at the host.
