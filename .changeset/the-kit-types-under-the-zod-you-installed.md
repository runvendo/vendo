---
"@vendoai/apps": patch
---

The Kit's props keep their real types under zod 4, instead of every one of them becoming `string`.

`@vendoai/apps` takes zod as a peer, so the Kit's schemas are built by whatever zod the HOST installed — and two walkers read those schemas: the checks floor's TypeScript printer, which decides whether a screen sets props that exist with types that fit, and the catalog prompt, which tells the model what each prop takes. Both switched on `_def.typeName` against `z.ZodFirstPartyTypeKind`. zod 4 tags a def with `_def.type` and ships no such enum, so every `case` compared `undefined` against `undefined`, the first one matched, and every prop in the Kit typed as `string`.

What that looks like on a real deployment: `gap?: string` where the Kit says number, `density?: string` where it says a two-word enum, `rows: string` where it says an array of records. 37 "takes string" refusals against real screens, nothing painting, and the agent reporting success over it. The `default:` branch that exists so a prop we cannot type precisely degrades to `any` — never to a false finding — was unreachable, so the failure was silent as well as total.

Both walkers now read one normalized answer from a single place that knows both layouts. The two are not merged field by field, because they collide: zod 3 keeps an array's element in `_def.type`, which is the field zod 4 uses for the tag, and zod 3 gives every object a `catchall` while zod 4 gives one only to an object that really keeps undeclared keys. So the tag decides how the rest of the def is read. Anything wearing neither tag — a construct outside the vocabulary, a stub, nothing at all — reaches the `any` net, which now has tests standing on it.

The zod-3 output is unchanged, byte for byte. The peer range did not move; this is what makes its claim true.
