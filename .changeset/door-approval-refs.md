---
"@vendoai/core": patch
"@vendoai/mcp": patch
"@vendoai/vendo": patch
---

A guarded call the MCP door parks now says so in a type, not only in English.

The door already answered a `pending-approval` with the sentence the model needs
— "This action needs approval. Approval apr_… is waiting in Maple's Vendo
approvals queue — resolve it there, then retry." That sentence is unchanged, and
it is still the whole content of the result. But it was also the ONLY answer, so
an agent loop that wanted to render an approval card had to regex an id out of
prose written for a reader, not a parser.

The parked result now carries `vendo/approval-ref@1` on `structuredContent`
beside the text: the same `{ kind, approvalId, summary }` envelope the in-process
tool pack has always returned to a BYO loop. Both venues mint it through one
producer in `@vendoai/core` (`vendoApprovalRef`), so an approval parked at the
door and one parked in an AI SDK loop describe themselves the same way and
`<VendoApprovalEmbed>` titles either card identically.

Only the parked case grew a field. An ok result, a block, a refused connection
and an error answer exactly as before, and the typed ref rides an `isError`
result safely: the official MCP client compiles an `outputSchema` validator for
ok results only.
