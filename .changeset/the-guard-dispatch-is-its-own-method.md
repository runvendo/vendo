---
"@vendoai/guard": patch
---

`bind().execute` keeps the decisions and hands the dispatch to a `#runOnce` private method: the grant the call runs under, the effect key, the in-flight share and the receipt write all sit together now, and the door above them reads as the four things it decides. No public surface changed, no behaviour changed, and no test changed.
