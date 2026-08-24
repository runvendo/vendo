---
"@vendoai/apps": minor
"@vendoai/harnesses": minor
"@vendoai/store": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

Files live where the work lives, and are really deleted when it is.

A file dropped into chat used to go into one global drawer, live there forever,
and belong to nothing. Now it belongs to the CONVERSATION: the upload lands in a
staging area, and the turn that receives the message moves it to
`/user/threads/<thread>/files/<name>` and rewrites the message before storing it,
so the agent's shell finds it at a stable address and later turns on that thread
still can. `/user/files` is now what its name always suggested — a keep-shelf for
things the user asked you to save — and the three `vendo_user_files_*` tools say
so, so the model stops shelving everything by reflex. Staged files that were never
sent are swept by the next turn.

Two real leaks close with it, both of which existed before this change:

- Deleting a conversation deleted ONE row. Its messages stayed in
  `vendo_thread_messages` forever, unreachable by any later erasure because the
  join that identified them had gone with the row, and its harness state stayed
  with them. The delete now runs the cascade that already existed — thread row,
  messages and state in one transaction — and sweeps the conversation's files,
  including the blobs behind them.
- Deleting an app never touched its workspace files or their objects. It now runs
  the store's own app cascade, which does.

Nothing in the file model is harness-specific: a sandboxed harness materialises a
conversation's files exactly as it materialises everything else, with no new code.
