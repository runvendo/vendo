---
"@vendoai/core": patch
"@vendoai/apps": patch
---

Remove the orphan wire text-edit surface and the inert reshape deprecation walker.

`applyTextEdits`, `recompileWithIdentity`, `TextEdit` and `TextEditResult` are
gone from `@vendoai/core`: the consumer was deleted when the conductor replaced
the generation engine, and nothing has called them since. The four `<Edit>`
patch issue codes they fed (`missing-edit`, `unknown-target`, `invalid-patch-op`,
`patch-invalid`) go with them, and the two generation prompts stop teaching an
`<Edit><Old><New>` dialect no parser reads — the "edit the text, never rewrite
the file" rule stays.

`findDeprecatedReshapeUsage` and its two orphaned constants
(`DEPRECATED_RESHAPE_OPS`, `DEPRECATED_FORMAT_KINDS`) are also gone. The notices
were never surfaced to anyone. The deprecated ops themselves keep compiling and
rendering for stored apps exactly as before.
