# Fix-leaks — the last four consumer-voice / honesty leaks (2026-08-03)

Branch `redesign/fix-voice-leaks` off the integrated `redesign/ui-s1`.
Law enforced: design §16 law 3 (no developer sentence, no id, no raw error ever
reaches an end-user surface) and the automations design's honest money.

## The proof

Captured headless in Chromium (Playwright 1.61) against the `packages/ui`
gallery card board (`gallery/cards.tsx`, the REAL components, no test-only
hatches) on `127.0.0.1:4271`, 2× device scale:

    cd packages/ui
    VENDO_CARDS_OUT_DIR=<this-dir>/cards node scripts/capture-gallery.mjs cards

| File | What it proves |
| --- | --- |
| `cards/grantset-model-instruction.png` | **LEAK 1.** demo-bank's own catalog sentences reach the card — "Amounts are integer cents (e.g. 285000 = $2,850.00): divide by 100 exactly once before displaying" and "This IRREVERSIBLY MOVES MONEY: it debits checking and appends a transfer" — and the rows read "Reads: Get spending insights" / "Changes: Transfer money". Not one word of the model's sentence is on screen; the cadence is said once, on the card's own line. |
| `cards/grantset-parked.png`, `grantset-approved.png`, `grantset-denied.png`, `grantset-slug-tools.png` | the same card at every state, in the new row voice. |
| `cards/adoption-*.png` | the paused-automation card's rows carry the same vocabulary (RISK_WORD is shared, so the two consent surfaces cannot drift). |
| `cards/connect-refused.png` | **LEAK 2.** The case CLICKS Connect on mount against a client that throws the real keyless refusal ("pass a Composio connector (composioConnector) to createVendo({ connectors }) or set VENDO_API_KEY"). On screen: "Connecting Slack isn't set up here yet — there's nothing you can do from this screen." The developer sentence goes to the dev-mode console. |
| `cards/approval-nested-money.png` | **LEAK 3.** Maple's live `host_createOrder` shape: `charge.amount_cents: 1850` renders "Amount cents: $18.50" one level down, while the *undeclared* sibling stays honest — "Amount: 1850 (unit not specified)". Declared → formatted, undeclared → said out loud, never a silent divide. |
| `cards/*--logo-failed.png` | the logo-CDN-blocked pass, unchanged by this lane (kept so the board stays complete). |

LEAK 4 (the remix menu's prefilled app id) has no browser scenario in the
harness — `<Remixable>` is only mounted in jsdom — so it is proven in
`packages/ui/test/chrome/remixable.test.tsx`: the prefill is exactly
"Update my TopMerchants remix: " and **no `app_…` token appears anywhere in the
panel**.

## The machine audit

    cd packages/ui && node <this-dir>/audit-cards.mjs   # → audit-cards.txt

Re-opens the same board in the same browser and checks each CARD's readable text
(the `article` plus its accessible names — not my figure captions, and not the
`title` attribute the consent honesty contract deliberately keeps the raw value
in) against the widened vocabulary: id-shaped token, code-call syntax, dotted
identifier path, environment variable, configuration instruction, model
instruction. Emails and URLs are lifted out first — a person's own content
belongs on their screen.

Result (`audit-cards.txt`): **28 cards audited · 0 violations · positive
control: all 4 known-leak strings flagged.** The positive control is the point —
an audit that flags nothing proves nothing, so the vocabulary is first run
against the four strings that WERE on screen during this wave, and the script
exits 2 if any of them slips through.

The same vocabulary is a unit gate in
`packages/ui/test/chrome/consumer-voice-law.test.tsx`, which additionally sweeps
the panels (activity, automations, connected accounts) and the waiting strip
against a wire fixture full of our plumbing, and greps ALL of `src/chrome` +
`src/voice` for the two shapes that produce the leak.

## Known open, NOT fixed here

- `packages/ui/src/chrome/approval-card.tsx` — owned by another worker this
  wave. Line 89/157 renders `descriptor.description` as the card's mandatory
  plain-words line, and line 117 renders `reason.message` on a failed decision.
  A model-instruction description therefore still reaches the approval card and
  its queue row (`waiting-queue.tsx:55` does the same, and must change WITH it
  or the two surfaces diverge). Cleaning demo-bank's catalog removes today's
  live instance; the structural fix belongs to that file's owner.
- `packages/ui/src/chrome/thread/composer.tsx` — owned by another worker. An
  attachment read error renders raw (line 141). It is also the file that must
  carry the non-visible prefill payload LEAK 4's grounding needs.
- `packages/ui/src/chrome/embeds.tsx:209` — a decided exception, documented at
  the render site: the BYO-agent embed's contract is that the wire failure stays
  legible. Left as decided, listed so it stays visible.
- `packages/ui/src/chrome/automations-panel.tsx:275` and `:568` — a failed
  unattended run's own code + message in run history. Needs a product decision
  about what a failed run may tell its owner; not a copy edit.
- demo-bank's `host_auth_*` / `host_demo_*` / `host_proof_*` / `host_voice_*`
  descriptions are raw HTTP lines ("POST /api/demo/pin"). They would render as
  an approval card's plain-words line if the agent ever called them. One
  route-summary each fixes it; out of this lane's scope.
- Lane G's committed `cards/*.png` are now stale for the grantset and adoption
  cases (their rows changed). Re-running `capture-gallery.mjs cards` with no
  `VENDO_CARDS_OUT_DIR` refreshes them in place.
