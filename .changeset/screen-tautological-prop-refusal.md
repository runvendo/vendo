---
"@vendoai/apps": patch
---

Stop a component screen's prop refusal from contradicting itself. When the value bound to a Kit prop differed from the prop's own type in one nested field — a `columns` array hoisted out of the JSX, so `align: "end"` widened to `string` before the enum saw it — the long-type summarizer collapsed BOTH sides to the same words and the screen agent was handed `prop "columns" on <DataTable> takes a list of rows, but this value is a list of rows`. A refusal that contradicts itself names no repair, so the agent retried forever, never painted, never errored and never escalated. Where the two summaries come out identical the check now falls through to the compiler's own nested sentence, which names the field that disagrees and the values it will take.
