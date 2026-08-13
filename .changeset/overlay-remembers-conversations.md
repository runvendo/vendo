---
"@vendoai/ui": patch
---

The overlay remembers conversations. A page reload resumes the conversation the user was in (the last adopted thread id persists per origin, and a transcript that ends mid-turn re-attaches to the in-flight stream), and a new previous-conversations header button — beside expand, new-conversation, and close — opens a picker listing the caller's earlier threads: select one to resume it in place, Cancel or Escape to stay. New conversation forgets the remembered id; a remembered id that no longer resolves (deleted thread, different signed-in user) self-heals to a fresh conversation through useVendoThread's existing validation, so a stale id can never strand the surface. The picker stays internal to the overlay — no new export surface — and the header icon ladder gains one slot in every pointer and takeover variant.
