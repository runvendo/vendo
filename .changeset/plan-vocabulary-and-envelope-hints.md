---
"@vendoai/core": patch
"@vendoai/apps": patch
---

Two generation-hardening fixes, both aimed at a model correcting itself instead
of an app failing outright:

- **The `.data` envelope binding miss now names the fix.** When a binding reads
  a field that is actually one level down, under the tool's own `data` field
  (`sum(accounts, "balance")` where `accounts` is `{ data: [...] }`), the fact
  check's "the real fields are: data" message now also says which path to use
  instead (`accounts.data.balance`) — the fix-it retry gets the exact
  correction rather than just the shape.
- **The plan's own vocabulary no longer leaks into a shipped app as an unknown
  component.** A worker filling a group, or the brain writing a whole app in
  one shot, occasionally copies the PLAN's own wrapper syntax
  (`<Leaf component="Stat" query="..." purpose="...">`, `<Group>`) verbatim
  into the markup it writes. `skeleton.ts`'s `withoutPlanVocabulary` already
  stripped `query`/`purpose` off a fill fragment's props; it now also resolves
  a stray `<Leaf component="X">` to the `X` it names and a stray `<Group>` to
  the `Stack` it always meant, and the same pass now also runs on the DIRECT
  create path (`validateCompiledCreate`), which has no fill fragment and
  previously had no defence against this at all.
