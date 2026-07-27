# Fidelity report — Linear

Verdict: **SHIP** — every dimension at or above the bar.
Threshold: every dimension ≥ 7/10. Scored against 3 evidence image(s): EVIDENCE operator screenshot (operator-1-linear-operator-1.png — real logged-in product UI); EVIDENCE operator screenshot (operator-2-linear-operator-2.png — real logged-in product UI); EVIDENCE live-site capture (https://linear.app).

## Round 1 — PASS

| Dimension | Score | ≥7? | Justification |
| --- | --- | --- | --- |
| logo | 8 | pass | The real Linear diagonal-stripe mark plus 'Linear' wordmark with chevron sits top-left of the sidebar exactly as in both operator screenshots, though rendered slightly smaller/lower-contrast than evidence. |
| palette | 7 | pass | Near-black sidebar/canvas and off-white text match, and status hues (yellow In Progress, purple In Review, green Done, label chips) track Linear's; but the built sidebar is flatter black without Linear's subtle gradient/elevation split, and the amber 'Open the Vendo panel' / red '1 Issue' toast are non-Linear template chrome. |
| type | 7 | pass | Inter-like geometric sans with correct weight pairing (semibold titles, muted metadata) mirrors evidence, but the issue title 'Fix onboarding checklist flicker' and 'New UI' headings are heavier/tighter than Linear's lighter large headings and the body sizes run smaller. |
| layout | 7 | pass | Issue view reproduces sidebar → breadcrumb header with star/… and 03/16 pager → title/description with inline code → Activity feed → right properties rail (status, priority, assignee, label, project) 1:1; but the sidebar drops Reviews/Pulse/More/Favorites sections, the properties rail lacks the ENG-2703 icon row alignment, and Overview lacks the Design › New UI breadcrumb and Overview/Issues tabs seen in operator-2. |
| copyTone | 8 | pass | ENG-#### keys, 'Triage Intelligence added the label Infra', 'Linear created the issue on behalf of sasha', status groups In Progress/In Review/Todo/Backlog/Done and labels iOS/Bug/API/Performance match Linear's vocabulary; the 'Open the Vendo panel →' button is off-domain leakage. |

Built screens: built-home.png, built-issues.png, built-overview.png
