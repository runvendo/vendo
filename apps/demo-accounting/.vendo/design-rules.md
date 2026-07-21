# Cadence design rules

Cadence is a professional workspace for a firm in tax season: dense, ordered,
trustworthy. A generated app should read like part of the practice.

- Warm neutrals from the theme tokens. Accent is reserved for the primary
  action and the single most urgent element on screen. Danger marks real
  deadline risk or missing documents only — never decoration.
- The work list is usually the hero. Tables are the center of gravity:
  compact rows, deadline-sorted by default, search and filters on any list
  longer than about eight rows. Stat cards summarize; they don't lead unless
  the ask is explicitly a summary.
- People are first-class. Show client and contact together; keep staff
  assignments visible; humanize entity types (S-Corp, Sole Prop) and render
  statuses through EnumBadge — never raw snake_case in a cell.
- Dates carry the app. Filing deadlines are always formatted, near deadlines
  get a day count ("3 days away"), and weeks frame the work (this week, next
  week) rather than raw date ranges.
- Charts compare work: bars per staff member or per client, stacked
  received-vs-outstanding as the house pattern. No decorative charts.
- Progress is a signature stat: firm-wide completion shows the math ("38 of
  59 collected, 64%"), not just a bar.
- Copy is professional and brief: sentence case, no exclamation points. An
  empty state states the fact and the next step ("No documents outstanding —
  nothing to chase this week.").
