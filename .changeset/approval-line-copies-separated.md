---
"@vendoai/ui": patch
---

The quiet line under a consent card survives being copied. The " · " between its
facts was drawn by CSS (`content` on a pseudo-element), and a browser hands
generated content to the accessibility tree but never to the clipboard — so
pasting the line into a bug report or a message to support gave back "This makes
a change you can’t undo, as you.asked in an app", every fact run into the next.
The separator is real text now, leading every item but the first, on all three
surfaces that draw the line (the approval ask, the press modal, the connect
row). It lives INSIDE the list item: a separator between the items copies just as
well and fails WCAG 1.3.1 ("`<ul>` and `<ol>` must only directly contain
`<li>`"). Screen readers hear exactly what they heard before, and screenshots of
all three cards are byte-identical.
