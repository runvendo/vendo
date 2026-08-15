---
"@vendoai/apps": minor
"@vendoai/ui": minor
---

Display bricks — the HTML a screen may write, contained by its box.

A screen had exactly one vocabulary: the Kit. Every arrangement it could not express had to be faked with a container that was never meant for it, and `<div>` was a type error. A screen now has ~21 display-only tags beside the Kit — `div`, `span`, `section`, `header`, `footer`, `aside`, `h1`–`h6`, `p`, `strong`, `em`, `small`, `code`, `blockquote`, `ul`, `ol`, `li` — each taking children and an inline `style`, and nothing else. Free CSS, off the host's own theme variables.

`DISPLAY_SPECS` and `DISPLAY_TAG_NAMES` are new on `@vendoai/apps/contract` (kit) and are the single source: the renderer resolves bricks beside `KIT_COMPONENTS`, the screen typings print them as the ONLY `JSX.IntrinsicElements` (so `<img>` and `<script>` stay errors, and `className` is an error on the tag), the type-check refusal names the legal tags, the tree's catalog check skips them like a text run, and the prompt and format reference teach them.

Security stays capability-shaped, never content-inspected. There is no style validator and no provenance scanner:

- Each brick is written out by hand and destructures exactly `style` and `children`. No spread, so `className`/`id`/`on*`/`data-*`/`aria-*`/`dangerouslySetInnerHTML` cannot arrive — not because a list refuses them, but because nothing carries them.
- ONE trusted-side filter drops the declarations that would FETCH (`url()`, `src()`, `image-set()`). A screen has no network; a beacon is a beacon whatever the URL says. The filter normalizes before it tests, the way the CSS tokenizer does: input preprocessing (CRLF, lone CR and form feed to one newline; NUL and lone surrogates to U+FFFD) and then escape resolution, so `\75 rl(`, `u\72 l(`, the fully-escaped spelling and every one of those routed through a custom property are caught — all reproduced fetching in real Chromium first. Honest framing: this closes every bypass we can demonstrate. It is a normalization pass, not a proof of completeness.
- The surface root paints inside its own box: `contain: layout paint; overflow: clip; position: relative; isolation: isolate`. `contain: paint` makes it the containing block for fixed descendants, so `position: fixed; width: 200vw` is held by geometry — nothing read the word "fixed".

One inert value changes side: `url\9 (` never fetched (whitespace between the ident and `(` is no function token), and normalizing puts a tab where the escape was, which the filter's `\s*` takes. It is pinned as dropped — buying it back would cost a second mechanism for a value that paints nothing.
