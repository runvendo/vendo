---
"@vendoai/vendo": major
---

**BREAKING:** the tool pack's app door is `vendo_make`, not `vendo_create_app`.

A BYO loop and a third-party agent at the MCP door now call the SAME tool, with
the same name and the same arguments. The pack's built-in used to be a second
public tool with its own name and a single `prompt` field, translated to
`vendo_make`'s `request` on the way in — two contracts for one capability, and
the one your model saw was the one the docs did not describe.

- `vendo_create_app` → `vendo_make`. There is no alias; a loop that hardcodes the
  old name in `include`/`exclude`, or a prompt that names it, must be updated.
- The tool's input is `vendo_make`'s own: `{ request }` required, `context` and
  `app` optional. `prompt` is gone; pass `request`.
- `VENDO_CREATE_APP_TOOL` is replaced by `VENDO_MAKE_TOOL` (re-exported from
  `@vendoai/core`) on `@vendoai/vendo/ai-sdk` and `@vendoai/vendo/mastra`.

Return shape is unchanged: a `vendo/app-ref@1` envelope with status `"building"`,
returned fast while the build streams over the wire.
