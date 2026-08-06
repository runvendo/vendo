---
"@vendoai/core": major
---

**BREAKING:** the deprecated V2 aliases from the pre-de-versioning naming
(0.4.x) are removed: `compileWireV2`, `printWireV2`, `validateTreeV2`,
`VENDO_TREE_FORMAT_V2`, `treeV2Schema`, `treeQueryV2Schema`, `TreeV2`, and
`TreeQueryV2`. Each was a pure re-export of its unversioned name — use
`compileWire`, `printWire`, `validateTree`, `VENDO_TREE_FORMAT`, `treeSchema`,
`treeQuerySchema`, `Tree`, and `TreeQuery` instead. The rename is mechanical:
drop the `V2` suffix.
