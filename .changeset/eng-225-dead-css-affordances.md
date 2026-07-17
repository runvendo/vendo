---
"@vendoai/ui": minor
---

Implement the full dead-CSS affordance set (ENG-225): copy actions on every
settled turn, code-block copy, drag-drop attach with image preview chips and
sent-attachment rendering in the transcript, the waiting-on-you approval queue
(mounted in VendoPage chat, exported as `WaitingQueue`), the `VendoToasts`
delivery surface with an imperative `vendoToast()` API and opt-in
approval-required toasts, and the connect dock + liquid tray in the composer
(new optional `connectors` catalog on `VendoProvider`; `ConnectCard`'s
initiate → OAuth → poll flow is now the shared `completeConnection`).
