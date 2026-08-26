---
"@vendoai/harnesses": patch
---

fix: redact reusable model credentials from chat output so end users can't extract them via the in-box agent

A boxed agent holds a reusable, non-expiring inference credential and streams
its output straight to the end user, so a user could steer it into printing the
key. The runtime now strips the literal credential value from everything a turn
puts on the wire — the assistant's prose and any tool output alike — through the
single writer every user-facing part crosses. This is defense in depth, not the
complete fix: a user who first asks the agent to transform the key defeats a
literal match. The full fix is per-session, short-lived brokering so the box
never holds a reusable key.
