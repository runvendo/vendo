---
"@vendoai/ui": major
---

**BREAKING:** the data hooks no longer return a generic `data` alias.

`useApps`, `useThreads`, `useActivity`, `useApprovals`, `useConnections`,
`useGrants`, `useAutomations` and `useApp` each returned the same value twice —
under the named field the contract makes canonical (`apps`, `threads`,
`events`, `pending`, `connections`, `grants`, `automations`, `app`) and again
as `data`. The alias is removed; read the named field. `error`, `isLoading`,
`refresh` and every write callback are unchanged.

```diff
- const { data } = useApprovals();
+ const { pending } = useApprovals();
```
