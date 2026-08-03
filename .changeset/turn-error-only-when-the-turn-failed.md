---
"@vendoai/agent": patch
---

Turn-error notices now appear only when the turn actually failed, and never
outlive the failure.

Three fixes to the `data-vendo-turn-error` part shipped alongside it:

**Recoverable tool errors are not turn failures.** The notice was written from
`toUIMessageStream`'s `onError`, which is the ai-SDK's general error-TEXT
formatter — it also runs for the `tool-input-error` and `tool-output-error`
chunks a hallucinated tool name or a throwing tool produces. The SDK feeds those
back and the model routinely answers on the next step, so a turn that finished
fine persisted permanent failed-beat alerts above its own answer. The notice is
now tapped off the merged stream's fatal `error` chunk instead, and is
once-guarded — the SDK runs the gate a second time over its own error text while
assembling the message to persist.

**A retry no longer inherits the failed turn's notice.** When a thread's last
message is an assistant turn the SDK CONTINUES it, reusing its id and its parts,
so the flagship keyless → `vendo login` → Retry flow appended the real answer
underneath the stale "no model key" line and persisted both — wrong on every
reload, forever. A new turn now clears the trailing turn's notice; anything that
turn really produced (partial text, tool beats) stays, and a turn left with
nothing else is dropped so the reply starts clean.

**Failures thrown before the model stream exists are recorded too.** Tool
building, `descriptors()`, and history conversion fail before any model chunk
exists, so those turns still persisted blank — the exact defect the part was
added to end. They now carry the same gated string, making good the previous
changeset's claim that the thread never shows a blank reply.
