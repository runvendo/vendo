---
"@vendoai/apps": patch
---

Every prop in the generated component catalog now says what it TAKES, and every brick carries one worked example. A line used to give prop NAMES only — `<DateTime> … · data: value · config: mode compact` — which tells a model nothing about whether `mode` wants a word from a closed list, a number or a function, and a prop written in the wrong shape is silently dropped at validation. Each prop is now `name: type`, with the type walked off its own zod schema: enums enumerated (`mode: "date"|"time"|"datetime"|"relative"`), primitives plain (`gap: number`), object shapes as their field names (`columns: {key?, label?, format?, align?, cell?}[]`), a handler as `fn`, a slot as `element`. The prop classes (`data` / `config` / `copy`) stay in front, because law 1 rides on them. Nothing is hand-written, so a schema that changes changes the prompt in the same commit.

Under each line sits that component's first worked example, taken from the same place `kitPrompt` takes it, so the two prompts can never show a model different idioms. Seven examples still wrote the retired attribute dialect — `onClose="ui.cancel"`, `$state.confirming`, an inline tool call for data, and a `<KeyValue pairs=…>` naming a prop that does not exist — and are corrected to the shape a screen actually compiles: state and setters for the overlays, `useQuery` results for the data.

The catalog costs 29,081 characters, up from 20,396; it still costs less than the 36,158 that a section per brick costs for the same bricks with no icon names at all.
