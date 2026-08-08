---
"@vendoai/core": patch
---

Core drops nine exports nothing calls. `inferFieldSemantic`, `humanizeEnumValue`, `semanticAtPointer`, `semanticFormatToken` and `describeSemantic` were orphaned when the dev-server inference pass was deleted — the semantics that reach generation come from the judge and the host's `overrides.json`, and no consumer in the monorepo or the console has called these since. `startSseKeepalive` was justified by "the `vendo try` dev server writes to a Node `ServerResponse`", a surface that does not exist; `withSseKeepalive` is the live keepalive and is untouched. `VendoApprovalWirePart`, `VendoConnectWirePart` and `requestNumberValues` had zero references. `declaredMoneyUnit`, `describeShapeWithSemantics`, `fieldSemanticSchema`, `toolSemanticsSchema` and the money-name regexes behind them are unchanged, and `declaredMoneyUnit`'s test now also pins the "a bare total is a count, not money" rule the deleted inference test carried.
