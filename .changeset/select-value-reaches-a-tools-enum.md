---
"@vendoai/apps": patch
---

A select's value can reach a tool's enum, and a payload fault names the tool.

A screen that fed a control's value into a tool whose input declares an ENUM had
no state it was allowed to hold. Typed to the tool's own union it was refused at
the handler, because the event a control hands a screen declared `value` as
`string`; widened to `string` it was refused at the payload. Both arms refused
correct intent, and the payload arm was stamped with the locus of the BUTTON the
call sat under — `<Button> prop "onClick"` — so every repair looked like the
handler and the model rewrote that handler for as long as it was allowed to.

`value` on the change event is `any` now, which is what a control's data really
is: a Slider reports a number and a multi-select an array, so the type it was
given was never the type it had. And a value the compiler refuses INSIDE a tool
payload is read as a payload fault wherever it files it — it names the tool and
lists the keys the tool's input accepts, the same sentence a misspelled payload
key already got.
