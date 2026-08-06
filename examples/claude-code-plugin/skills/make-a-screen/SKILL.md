---
name: make-a-screen
description: Use when an answer about the connected product would land better as something the person can look at and use than as text you type out — a comparison, a trend, many rows, a thing they will come back to, or a thing they need to act on. Also use when they ask to change a screen they already have.
---

# Making the person a screen

The connected product exposes one tool for this: `vendo_make`. It is the only
way to put a screen in front of the person, and you never build UI yourself.

## When an answer wants to be looked at

Reach for `vendo_make` when the honest answer is a shape rather than a sentence:

- **more than a handful of rows** — you would be reading a table out loud
- **a comparison, a trend, or a breakdown** — anything with an "over time" or
  "versus" in it
- **something they will come back to** — "keep an eye on", "every week", "track"
- **something they need to act on** — a screen can carry the buttons; your
  message cannot

Answer in words instead when the answer *is* words: one number, one status, one
fact, a yes or no, or an explanation. A screen for "what's my balance" is worse
than saying the balance.

## How to phrase `request`

`request` is prose — what you would say to a designer sitting next to you. Say
what the person wants, in your own words.

- **Do** describe the want: "the last three months of spending, broken down by
  category, with a way to jump into any month"
- **Don't** describe an implementation: no component names, no layout grids, no
  JSON, no field names you guessed at
- **Don't** ask for fonts, colors, or branding — it inherits the product's own
- **Don't** bake in data. Never paste numbers you looked up or computed
  ("Total: $4,210"). The screen binds live data itself, and hardcoded figures
  are rejected as invented

Pass `context` for background the product cannot see from its side: what they
told you earlier in this conversation, a constraint they mentioned, which of
several things they meant. Free text, a couple of sentences.

Pass `app` **only** to change one specific existing app you already have the id
for. Leaving it out lets the product decide whether to continue the last thing
or start something new — which is usually the right call.

## What comes back, and what does not

You get a receipt: an id, a title, a status, and `say` — one line written in the
person's voice. **Say `say`, close to verbatim.** That is the whole report.

You never get the screen. Pixels travel from the server straight to the
person's own page, on a channel you are not on.

So:

- **Never wait for it.** There is nothing to poll and nothing to check. The
  receipt is the end of your turn's work on it.
- **Never describe it.** You have not seen it. Do not narrate sections, charts,
  colors, or buttons, and do not tell them what to click.
- **Never paste a link or an id** unless they asked for one.
- If `status` is `"failed"`, try once more on the same `app` with a narrower
  request. If it fails again, say so plainly and stop.
- If `status` is `"building"`, that is the honest answer: it is on its way.
  Say the line and move on.
