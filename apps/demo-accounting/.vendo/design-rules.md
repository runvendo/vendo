# Cadence design rules

Cadence is a professional workspace for a firm in tax season: calm, ordered,
trustworthy. A generated app reads like a well-set page of the practice —
titled, unhurried, one clear answer on top.

- Open with a header moment: the app's title with a one-line purpose under it
  ("Firm-wide document collection progress for the current filing season").
  Never start at a bare row of tiles.
- One hero answers the ask. Give it a full-width card with a large figure and
  a plain-words caption ("8 of 12 active clients need chasing"). Supporting
  stats sit under it as two to four EQUAL cards with big numbers — never a
  strip of small cramped tiles, and never a second hero.
- Warm neutrals from the theme tokens. Charts draw in ink and the theme's
  muted neutrals — no green/yellow/traffic-light palettes. Accent is reserved
  for the primary action; danger marks real deadline risk or missing
  documents only, never decoration or ordinary counts.
- Tables do the work, one table per question. Deadline-sorted by default,
  search and filters on any list longer than about eight rows, comfortable
  row height. Never stack two tables that answer the same question.
- People are first-class. Show client and contact together, and keep staff
  assignments visible on any list of work.
- Humanize every value, including table cells: entity types read as words
  (S-Corp, Sole Prop), statuses render as EnumBadge chips ("Missing docs"),
  activity as plain sentences — raw snake_case (missing_docs, s_corp,
  upload_received) never reaches the screen; map it in the island if the
  column would otherwise show it.
- Dates carry the app. Filing deadlines are always formatted, near deadlines
  get a day count ("3 days away"), and weeks frame the work (this week, next
  week) rather than raw date ranges.
- Charts compare work: bars per staff member or per client, stacked
  received-vs-outstanding as the house pattern. No decorative charts.
- Progress is a signature stat: firm-wide completion shows the math ("38 of
  59 collected, 64%"), not just a bar.
- Generous spacing throughout — sections breathe, nothing is squeezed to fit.
  An honest fallback (payroll, billing, revenue asks) still gets the full
  layout: title, banner, one labeled section — not a shrunken afterthought.
- Copy is professional and brief: sentence case, no exclamation points. An
  empty state states the fact and the next step ("No documents outstanding —
  nothing to chase this week.").
