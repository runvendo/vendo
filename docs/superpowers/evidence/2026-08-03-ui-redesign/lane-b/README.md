# Lane B — card shell, real-browser proof (2026-08-03)

Captured headless in Chromium (Playwright 1.61) against the `packages/ui`
harness on `127.0.0.1:4272` (`e2e/harness/vite.config.ts`, real wire fixture,
real components). Videos → GIF via ffmpeg.

| Flow | Files | What it proves |
| --- | --- | --- |
| Thread-style consent card | `card-flow.gif`, `card-01-card.png`, `card-02-approved.png` | `/approval` — ONE shell (`fl-cardshell fl-cardshell--ceremony fl-approval fl-item-in`), eyebrow · 28px well · title · mandatory line ("Permanently delete an invoice") · field rows (Invoice id / Permanent) · byline · ONE ceremony button; Approve resolves. |
| N1 waiting strip | `strip-flow.gif`, `strip-01-collapsed.png`, `strip-02-expanded.png`, `strip-03-cleared.png` | `/waiting` — count-first "WAITING ON YOU · 1"; Approve is genuinely hidden while collapsed (`isVisible() === false`); expands in place to the SAME shell (humanized `To / a@example.com`, never the fixture's raw `to a@example.com` preview); the strip clears itself on decide. |
| Mobile sheet | `sheet-flow.gif`, `sheet-01-sheet.png`, `sheet-02-approved.png` | `/thread-humanized` at 390×844 — the sheet SIZES the card and no longer undresses it: computed `padding 16px 18px`, `border 1px solid`, `background rgb(255,253,249)`, `radius 16.8px`, `width 358px`. |

Known, expected in `sheet-*`: the amount still reads `4200 (unit not specified)`.
That is the in-thread synthesis in `thread/parts.tsx` (Lane C's file) still
passing `inputSchema: {}`; `thread/approval-wire.ts#buildApprovalRequest` is the
fix and is unit-proven in `test/chrome/approval-degraded.test.tsx` ("formats
money IN-THREAD once the wire part's schema rides along"). The conductor wires
the builder into `parts.tsx` at integration, which flips this frame to `$42.00`.

Not captured on demo-bank: a card only appears there after a live guarded agent
turn (app generation is broken on this branch and `next start` needs
`AUTH_SECRET` + a login), and demo-bank has no director mode. The harness is the
deterministic real-browser path for these three flows; Lane G's gallery CARDS
section is where card appearance becomes gate-visible.
