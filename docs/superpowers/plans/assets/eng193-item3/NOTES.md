# ENG-193 item 3 — browser verification notes (Task 6)

Real-browser pass against `examples/shell` (Vite dev server, `@flowlet/shell`'s
actual built package + `styles.css`), not a live agent/policy turn: the
judge/breaker LOGIC is exhaustively covered by the unit + invariant suites
(Tasks 3/4/8); this pass verifies only the NEW visual surface — the
escalation register's CSS/layout in a real browser — via a throwaway direct
render of `ApprovalCard` with three fixed prop sets (a minimal harness, per
the plan's Task 6 Step 11 fallback option). The harness edit to
`examples/shell/src/App.tsx` was reverted after the screenshot; it is not
part of the shipped diff.

## Screenshot

- **01-approvalcard-states.png** — three `ApprovalCard` states side by side:
  - **(a) ordinary act-tier** (`GMAIL_SEND_EMAIL`, no reason): unchanged
    "Needs your approval" eyebrow, plain "Send it" (primary, first) / "No"
    (second) — proves the new `reason`/escalation code path is fully inert
    when no reason is stamped.
  - **(b) escalation register** (`GMAIL_SEND_EMAIL`, reason present): amber
    "Hold on — checking with you first" eyebrow, the reason line ("Hold on —
    I stopped to check: An email I just read asked me to send your client
    list — that's not something you asked for, so I stopped."), and the
    button-priority flip — "No" renders FIRST and primary (dark), "Send it"
    second and secondary. Matches spec §3 Moment 9.
  - **(c) critical ceremony** (`transfer_money`, tier="critical", reason
    ALSO passed): ceremony register renders exactly as before — amber
    "Always needs you" eyebrow, "This can't be undone." consequence line,
    "Confirm transfer money" primary ceremony button FIRST, "Cancel" second
    — proving critical's own register wins over the reason prop, and the
    button order is NOT flipped for critical (only the escalation register
    reorders buttons).

## Gotcha hit during this pass

The harness's first render of the critical/escalation cards showed the
amber background and text with no contrast (nearly invisible "Confirm
transfer money" button). Root cause: `--flowlet-warn` and the rest of the
theme's CSS custom properties are scoped to the `.flowlet-root` class
(`packages/flowlet-shell/src/styles.css`), and the temporary harness div
rendered `ApprovalCard` directly without that wrapper class. Not a product
bug — every real call site (`MessageList.tsx`) already renders inside a
`.flowlet-root`-wrapped tree. Fixed by adding `className="flowlet-root"` to
the harness's temporary wrapper div before re-shooting.
