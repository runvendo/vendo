---
"@vendoai/vendo": patch
---

A parked call's one line says what is waiting, not what state it is in. The tool
pack minted it as "Awaiting user approval: List your todos — host_getTodos
{…}", and `<VendoApprovalEmbed>` titles the card with that line for the rest of
the request's life — so after the person pressed Approve, the receipt read
"Awaiting user approval: List your todos" directly over its own "Approved —
ran". The mint now describes only the call; the state stays with the surface
that knows it, which was already saying it on the line underneath. The line
keeps the guard's preview vocabulary, so a BYO loop reads the same call it
always did.
