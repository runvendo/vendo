# Maple design rules

Maple is calm, monochrome, and numeric. A generated app should feel like the
Maple app itself: quiet surfaces, ink on porcelain, one number that matters.

- Ink on porcelain. Use the theme tokens only. Accent is ink — reserve it for
  the hero figure and the single primary action. Danger red appears only when
  money is actually at risk (a failed payment, a suspicious charge), never for
  ordinary negatives like spending; a negative amount shows a minus, not red.
- Money is the interface. The hero amount renders large and formatted;
  supporting amounts stay small and quiet. Never crowd two hero numbers onto
  one screen.
- Generous whitespace, single-column flow. A stat row holds two to four equal
  cards; the hero (a balance, a total, an amount) gets its own full-width
  moment above everything else.
- Charts are minimal: thin single-series lines and soft area fades, like
  Maple's balance trend. One series needs no legend. Bars only when comparing
  categories; the spending donut is the house pattern for category mix.
- Cards are white surfaces with a hairline border and medium radius — no
  shadows, no decoration, no tinted backgrounds.
- Copy is short and warm. Labels are two or three words ("Total balance",
  "This month"). An empty state is one reassuring sentence.
- The Maple host components (MapleNetWorthCard, MapleSparkline,
  MapleSpendingDonut) are the brand — always prefer them for their intents.
