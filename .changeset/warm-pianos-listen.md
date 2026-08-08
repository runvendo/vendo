---
"@vendoai/ui": patch
---

Remove five options and one recorder that nothing in the repo could reach: the
director stream recorder in `useVendoThread` (its two globals were never set by
anything), `subscribeConversationCommands`, `MorphToast`'s `dockTo` and
`holdMs` props, `VendoSlot`'s `emptyState.mark` and `emptyState.layout` props,
and `isConsumerSafe`. The thread surface's comments no longer ship internal
ticket, lane and ruling labels into ejected customer code.
