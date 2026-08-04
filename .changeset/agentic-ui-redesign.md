---
"@vendoai/ui": minor
---

The agentic UI redesign: visible work, one card system, the ChatGPT-shaped center.

Every consent, connect, grant-set, adoption and voice surface now renders
through one card shell, so geometry lives in a single place and the cards
differ only in contents. The transcript shows the agent's work as quiet human
beats instead of lifecycle strings, and the center is a rail with New chat and
two named doors over a pure home.

Behaviour hosts may notice:

- **`colors.border` is no longer read by the chrome.** The hairline is derived
  as ~8% of the foreground so the edge sits the same distance from text in any
  brand and in both colour schemes. A host that tuned `colors.border` to change
  Vendo's hairline will see no effect. `radius.small` and `radius.large` are
  now read (previously only `radius.medium` drove the sheet).
- **A consent card's plain-words line comes from the RISK GRADE**, never from
  the tool's name. Host-authored `ToolMeta.description` still wins, and a
  sentence synthesized from the real inputs still outranks the class line. A
  tool nobody graded reads as ungraded, keeps its ceremony, and never folds its
  inputs behind a disclosure.
- **Descriptor text never reaches an end user.** A tool descriptor's
  `description` is authored for the model; the card reads host `ToolMeta`
  instead, and falls back to copy Vendo wrote.
- One shared approvals feed replaces three independent pollers (measured 39 →
  13 requests per 60s across three surfaces).
- The mobile takeover inerts the host behind it rather than covering it, and no
  longer mints a second `<main>` landmark.
