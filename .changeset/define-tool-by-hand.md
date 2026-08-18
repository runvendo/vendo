---
"@vendoai/core": minor
"@vendoai/vendo": minor
---

A tool you write by hand is now three lines of typing, not a hand-built descriptor.

The `tools:` slot has always taken a `ToolDefinition` — a descriptor plus an
`execute` — but writing one meant authoring JSON Schema by hand beside a
TypeScript function, and then keeping the two honest about each other forever.
Nothing checked that they agreed. A schema that said `id` was required while the
function read `taskId` was a tool the model could only call wrong.

`defineTool` takes the schema once, as zod, and derives both halves from it: the
JSON Schema the model is shown, and the parse that runs before `execute`. A call
whose arguments the schema rejects is refused with a message naming the field,
and the body never runs. `risk` is required and graded — you wrote the tool, so
you know what it does; `ungraded` stays the answer only extraction is allowed to
give.

What comes back is a plain `ToolDefinition`, so nothing is hidden behind the
helper: every descriptor field it does not ask for is a spread away
(`{ ...defineTool({ … }), confirmEach: true }`), and the tool joins the one
registry under the name it declared, guarded, audited and projected exactly like
an extracted one.

Schemas are read in zod 4's shape. On zod 3.25 or later that is the `zod/v4`
import; a zod 3 schema is refused at definition time with the import that fixes
it, rather than crashing somewhere inside schema conversion.
