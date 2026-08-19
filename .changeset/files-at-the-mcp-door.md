---
"@vendoai/vendo": minor
"@vendoai/core": minor
---

An outside agent can put the user's files at the MCP door, and read them back.

The door used to withhold `vendo_user_files_list` and `vendo_user_files_read`
from every external client. That fence is gone: an outside agent connects AS the
user, and reaching the files that user shared is the point of connecting. The
isolation that matters was never per-door — it is per-USER, and it is
structural, because every hand opens the workspace for the caller's own
principal and there is no subject argument to get wrong.

`vendo_user_files_put` is the third hand: one file, by name, into the caller's
own drawer, replacing anything already saved under that name. Text rides in
`content` as-is; anything else rides base64 with `encoding: "base64"`, because a
tool call is JSON and JSON has no bytes. It honours the SAME
`createVendo({ uploadMaxBytes })` cap as the drop door and refuses in the same
sentence — one cap, named in one place, so a file refused in chat cannot be
admitted by asking over MCP instead.

Reading back a file that is not text is now an honest answer instead of a blank
one. A parquet, a database file or anything else still STORES, and the read says
so: that the file is saved, that its contents cannot be read back yet, and
exactly which types do come back as text — so an agent can ask the user for a
CSV rather than narrate an empty result.
