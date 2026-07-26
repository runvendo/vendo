# Fidelity report — Linear

Verdict: **SHIP** — every dimension at or above the bar.
Threshold: every dimension ≥ 7/10. Scored against 3 evidence image(s): EVIDENCE operator screenshot (operator-1-linear-operator-1.png — real logged-in product UI); EVIDENCE operator screenshot (operator-2-linear-operator-2.png — real logged-in product UI); EVIDENCE live-site capture (https://linear.app).

## Round 1 — FAIL (logo)

| Dimension | Score | ≥7? | Justification |
| --- | --- | --- | --- |
| logo | 6 | FAIL | Sidebar top-left carries a Linear-style circular mark plus 'Linear' wordmark with the chevron, matching the evidence's placement, but the wordmark renders far too dim/low-contrast versus the crisp white 'Linear' in both operator captures. |
| palette | 7 | pass | Near-black canvas, #1a1a1a panels and grey secondary text track Linear's dark theme, and yellow star / amber In Progress icon are right, but the built background reads flatter/pure-black than Linear's slightly lifted #0e0e11 and the blue avatar chip plus violet 'Ask Linear' badge introduce accents absent from the evidence. |
| type | 7 | pass | Inter-like geometric sans with semibold ~24px issue title, 13px sidebar labels and grey small-caps section headers closely mirrors the evidence hierarchy; project H1 weight/tracking is slightly heavier than the reference 'New UI' heading. |
| layout | 8 | pass | Issue view reproduces the three-region composition of operator-1 (nav rail with Inbox/My issues/Reviews/Pulse, Workspace: Initiatives/Projects/Views/More, Favorites; title+star+… header with nav arrows; right ENG-#### property rail with status/priority/assignee/team), and /project mirrors operator-2's icon, title, subtitle, Properties/Initiatives/Resources rows, Description and Overview|Issues tabs; missing search/compose spacing and per-page nav highlighting is inconsistent (multiple boxed items on /issues). |
| copyTone | 8 | pass | Domain vocabulary is right — ENG-2728, Backlog/No priority, labels API & SDK, 'Rate-limit headers missing from SDK', 'Component library revamp' with initiatives 'Design systems overhaul' — plausibly invented like the evidence's 'Faster app launch'/ENG-2703, though 'My Issues' is capitalized where Linear writes 'My issues'. |

Built screens: built-home.png, built-issues.png, built-project.png

## Round 2 — PASS

| Dimension | Score | ≥7? | Justification |
| --- | --- | --- | --- |
| logo | 9 | pass | Built sidebar header shows the real Linear angled-disc mark plus 'Linear' wordmark with dropdown chevron in the exact top-left workspace-switcher slot as both operator screenshots. |
| palette | 7 | pass | Near-black #08080a canvas, muted gray sidebar labels and yellow/amber 'In Progress' + gold star match evidence, but sidebar active rows are lighter/flatter gray boxes and accents like the blue avatar and indigo 'Ask Linear' pill drift from Linear's subtler tinting. |
| type | 8 | pass | Inter-like geometric sans with same semibold page titles, ~13px medium nav labels, small gray metadata and inline bold actor names mirrors the operator issue view hierarchy closely, just slightly smaller title scale. |
| layout | 8 | pass | Issue view reproduces sidebar (Inbox/My Issues/Reviews/Pulse, Workspace with Initiatives/Projects/Views/More, Favorites) + title bar with star/ellipsis + ENG-#### right properties rail, and /project mirrors the icon/title/subtitle/Properties/Initiatives/Resources/Description stack with Overview·Issues tabs; missing the pagination '02/145' counter and per-property icon rail nuances. |
| copyTone | 8 | pass | Domain-correct vocabulary — 'Rate-limit headers missing from SDK' ENG-2728, Backlog/No priority, labels API·SDK, 'Component library revamp' with ENG, DES, PRO and Jul → Q4 '26 — reads like real Linear records, though the activity line 'Engineering created this issue' is less specific than evidence's actor/integration phrasing. |

Built screens: built-home.png, built-issues.png, built-project.png
