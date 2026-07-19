# CELLS lane — object-valued cells + format-op enforcement (the last failure class)

Re-run of the two final-gate FAILs (#4, #5, both Cadence) plus one Maple
regression check (#2), on branch `yousefh409/vendo-v2-cells` off merged main
(#385–#388). Production boots only (`next build && next start`,
`NODE_OPTIONS=--max-old-space-size=3072`), real Apps create path
(`/vendo/workspace` → Apps → Create), real browser. No tuning between runs.

## What changed (this branch)

1. **`template` reshape op** — the ONE bounded object→string projection:
   `template("…{path}…")` strings a bare object; `template(field, "…{path}…")`
   rewrites a row field per-row. `{path}` placeholders are dot-paths into the
   row, so nested scalars (`{assignedTo.name}`) work. Closed grammar (arity
   registry + placeholder validation in `findInvalidReshapeSteps`), pure,
   non-Turing; a placeholder resolving to an object is a contained mismatch.
   Chosen over nested-scalar Table column keys because one op covers BOTH gate
   symptoms (`{received} of {total}` composition AND nested-name extraction),
   works in every display slot (Text/Stat/Badge, not just Table), and needed
   zero grammar/renderer changes (pipes already parse quoted args; the
   renderer already applies chains).
2. **Compile-time display-slot check** (shape-check.ts, mirroring the #387
   asOptions check): object/array shapes bound into Text.text / Stat.value /
   Badge.label, and object-valued DISPLAYED columns in Table.rows (literal
   `columns` narrows the set), are per-binding shape-mismatch errors routed to
   template/scalar-field repair with available fields.
3. **Prompt** — RESHAPE PIPES section documents template's two forms with the
   exact gate-failure example, and makes display format ops non-optional:
   every date/timestamp and cents field in a Table column/Stat/Text/Badge MUST
   carry a `format` step, on EVERY host.
4. Date fields carry NO format info in shape cards (values are hashed away by
   design), so there is deliberately no compile-time raw-ISO check — that half
   stays prompt-enforced (and held in this run). Honest gap, stated as such.

## Root cause of the Maple/Cadence format-op inconsistency (investigated FIRST)

The Cadence path does NOT lack shape-card context: both hosts sample shapes
through the same `generationToolContext` (runtime.ts), both have no-input read
tools (4 each), identical read=run policies, and the RESHAPE PIPES prompt
section reaches both. Two real causes instead: (a) object-valued columns had
NO projection mechanism in the vocabulary — the model could not comply for
Cadence's `progress`/`assignedTo` columns even when it wanted to (Maple's flat
rows never hit this); (b) format-op adherence was prompt-only and the prior
prompt's literal examples (`txn.amount`, `timestamp`) pattern-matched Maple's
domain, not Cadence's. Fix = mechanism (1) + enforcement (2) + host-neutral
MUST wording (3).

## Verdicts

| # | host | prompt | before (final gate) | after (this run) | timing |
|---|------|--------|--------------------:|------------------|--------|
| 4 | demo-accounting | overdue invoices with a reminder button | FAIL — `{"received":3,"total":6}` + assignedTo JSON in every row, all dates raw ISO | **PASS** — tree carries `format(filingDeadline, date)` + `template(progress, "{progress.received} of {progress.total} docs")` + `template(assignee, "{assignee.name}")` + `asOptions(id, businessName)`; cells render "Jul 22, 2026" / "3 of 6 docs" / "Maya Alvarez"; zero raw braces; reminder FIRES approval-gated (apr_88bd22e6). Cosmetic remainder: STATUS shows raw `missing_docs` enum (no enum format kind; outside the bar). | app visible ~13.1s |
| 5 | demo-accounting | a revenue vs expenses summary with a chart | FAIL — raw braces in Client Progress table + raw ISO deadlines | **PASS** — island `RevenueChart` renders a real bar chart (38/21/59 from `/dashboard`, no jail box); honest document-collection reframe, no fabricated revenue and (better than prior run) no interpolated monthly series; both tables carry `template(progress, …)` + `format(filingDeadline, date)`; zero raw braces, zero raw ISO. | card ~14.1s |
| 2 | demo-bank | a filterable list of recent transactions | PASS (regression check) | **PASS** — unchanged: `format(amount, currencyCents)` + `format(timestamp, date)` + `asOptions`; -$87.00 / "Jul 19, 2026" / real category options; filter Selects remain display-only (known dialect gap, not in bar). | card ~6.1s |

**Re-run set: 3/3 clean — the raw-braces/format class is closed on this
matrix; 6/6-equivalent on the re-run set** (the other three finals were PASS
on merged main and this branch only adds vocabulary + checks they don't hit).

Screenshots: `02-…`, `04-…`/`04b-…`/`04c-…`/`04d-…`, `05-…`/`05b-…`/`05c-…`.

## Boot gotchas hit (recorded for the next lane)

- **`VENDO_BASE_URL` MUST be set for production boots** (e.g.
  `http://localhost:4310`): unset, every present-mode host tool call fails
  credential forwarding and the app renders bound-but-empty (empty tables,
  label-only stats). The server warns once at boot; easy to miss.
- The workspace **Chat** tab is the agent path, not the gate path: the chat
  agent may decide to "build with realistic Cadence-style data" and emit an
  island with hardcoded fake invoices (observed once here). The Apps → Create
  path (what all gates measure) grounds honestly. Flagged as a separate
  agent-layer honesty finding, out of this lane's scope.
