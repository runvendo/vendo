---
"@vendoai/core": major
"@vendoai/apps": major
"@vendoai/agent": major
"@vendoai/harnesses": major
"@vendoai/ui": major
"@vendoai/vendo": major
"@vendoai/guard": major
"@vendoai/store": major
---

One front door: `vendo_make` replaces `vendo_apps_create` and `vendo_apps_edit`,
and it hands back words instead of the app.

**Breaking.** `vendo_apps_create` and `vendo_apps_edit` no longer exist. In their
place is one tool with three parameters:

```ts
{
  request: string,   // the ask, in the calling agent's own words — required
  app?: string,      // an existing AppId, to change that one specifically
  context?: string,  // free-text background, for callers whose conversation we cannot see
}
```

Two tools meant every calling agent — ours, a host's own AI SDK or Mastra agent,
an outside agent over MCP — had to decide "new or change?" before it could ask,
and get it right. That was never their decision: the seam knows whether an app
exists, and a caller that wants a specific one says so with `app`. `context`
exists because an outside agent's transcript is not ours to read; on our own
doors the runtime's transcript stays authoritative and `context` is supplemental.

**Also breaking: the tool returns a receipt, not the document.**

```ts
interface MakeReceipt {
  id: AppId;
  title: string;
  status: "ready" | "building" | "failed";
  say: string;   // ONE speakable line, consumer voice
}
```

The old tools returned the entire `AppDocument` — the tree, the island sources,
the storage declarations, the machine reference. So a model was handed UI and
trusted not to describe it, retell it, or invent from it. A model handed a tree
eventually talks about the tree. Screens go server → slot; the agent only ever
gets words, and `say` is the line it can utter verbatim. `status: "building"` is
the honest answer while work continues.

Two things follow from the receipt, and both are improvements rather than
compromises. The automation card is now PUBLISHED by the apps runtime through the
existing view-stream seam instead of being reconstructed at the agent bridge out
of the edit tool's return value — one less part read by shape (01-core §16's own
anti-smuggling rule, which that reconstruction was the exception to). And
`instant()` now speaks the receipt's `say` rather than a canned "Updated.",
which fixes a real mis-speak: a rejected change comes back OK, so the canned line
claimed success for work that did not happen.

**Migrating.** If you call the tool by name from your own agent, rename it and
rename `prompt` → `request` and `appId` → `app`; drop `instruction` into
`request`. If you read fields off its result, read `id` and `title` off the
receipt and say `say`. If you had a policy rule or an override matching
`vendo_apps_create` / `vendo_apps_edit` / `vendo_apps_*` for the build tools,
match `vendo_make` — it deliberately sits OUTSIDE the `vendo_apps_` prefix,
because it is the front door rather than a member of the runtime's family. Core
exports `isVendoAppsTool(name)` for anything that needs to recognise both.

Everything else about the call is unchanged: risk grade `read` (actions inside
the screen are still graded and consented individually at call time), the view
channel, the build-failed banner, and the transcript's build card.
