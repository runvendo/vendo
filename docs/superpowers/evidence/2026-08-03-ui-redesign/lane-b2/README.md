# Lane B2 — card polish, real-browser proof (2026-08-03)

Why this folder exists: the Lane B proof was captured on the `packages/ui` e2e
harness page whose own debug element prints `resolved: {"approve":true}` after a
decision, so the evidence read exactly like the defect the wave spent itself
killing — and it never showed a card SETTLING. **No capture here contains any
harness debug output, and every flow runs pending → decide → settled.**

Each capture is machine-audited before it is written. The capture script reads
the page's full visible text and fails the run if it finds any of:

- an id-shaped token (`app_`, `apr_`, `thr_`, `grt_`, `run_`),
- the harness recorder text (`resolved: {…}`),
- a raw boolean field value (a row ending in `true`/`false`),
- `waiting for your approval` (the doubled narration),
- `Vendo will run` (the robotic plain-words line).

All eight audits (four flows × pending/settled) reported **clean**.

## Surfaces

| Flow | Files | Surface — exactly what was running |
| --- | --- | --- |
| **Ordinary approval, whole lifecycle** (hero) | `lifecycle-flow.gif`, `lifecycle-01-pending.png`, `lifecycle-02-settled.png` | The SHIPPED BYO approval embed (`VendoToolResult` → `VendoApprovalEmbed`) over the real wire fixture, Maple theme — harness route `/approval-lifecycle`, which renders full-bleed with no harness heading. The wire's own pending ask (`host_email_send`, risk `write`): pending card → Approve → the wire executes → the card resolves in place to `Approved — ran` with the executed result (`Delivered  Yes`). Byline in frame: `Runs as you · asked here in chat` — no id. |
| **Ordinary approval in the thread** | `ordinary-01-card.png`, `ordinary-02-card-closeup.png` | The SHIPPED `VendoThread` + `VendoProvider` (Maple theme) over the wire fixture — harness route `/thread-ordinary-consent`, also full-bleed. This is the appearance hero: the plain register (one primary button, no amber), the host's own sentence, and boolean inputs reading `Include transactions  Yes` / `Notify recipient  No`. |
| **Connect card lifecycle** | `connect-flow.gif`, `connect-03-harness-pending.png`, `connect-04-harness-connected.png` | The SHIPPED `ConnectCard` over the wire fixture (harness `/connect-lifecycle`, Slack): Connect → the broker reports the account active → the card settles into its quiet `Connected` record in place. |
| **Ceremony (destructive) approval — the real product** | `ceremony-flow.gif`, `ceremony-01-pending.png`, `ceremony-02-morph.png`, `ceremony-03-settled.png` | `examples/demo-bank` (Maple) on `localhost:3221`, signed in as `yousef@maple.com`, real scripted turn → real guard → real parked approval. "Move money to savings": the amber ceremony card reading **"Sends $200.00 to Maple Savings ··8820 — now, as you."** with every input in plain sight → Approve → the morph notification (`Send money — approved`) → the settled transcript ("Done — $200.00 moved to savings…"). Labelled ceremony on purpose: this is the alarming-looking variant, deliberately NOT the hero. |
| **Standing access (grant set) + connect — the real product** | `standing-flow.gif`, `standing-01-pending.png`, `standing-02-settled.png`, `connect-01-pending.png`, `connect-02-card-closeup.png` | Same Maple server, signed in as `mia@maple.com` (the second seeded staff member, whose standing grants have never been given, so the consent moment is the real first-time one). "Email me a weekly summary": the automation card, then `STANDING ACCESS / Weekly spending summary needs 2 permissions` → Allow both & enable → the settled record `Enabled · 2 permissions granted` with a tick per permission, in place, then the Gmail connect card in the same turn. |

## Notes, honestly

- **The ordinary register does not exist in demo-bank.** Every tool Maple lets an
  agent call that is not read-only is marked `risk: "destructive"`
  (`examples/demo-bank/.vendo/overrides.json`), so the only single-ask card the
  product can produce is the amber ceremony one. That is why the ordinary hero is
  captured on the shipped components over the wire fixture, and why every card
  proof in this repo up to now was gold-bordered.
- **The venue byline only renders on queue surfaces** (`showContext` defaults
  true; the in-thread card sets it false because the wire carries no ctx). The
  in-product surfaces Maple mounts do not include one, so the byline fix is
  visible in `lifecycle-01-pending.png` and pinned by three unit tests; the
  audit above additionally proves no id reaches ANY frame.
- **The Gmail connect card's connected state is not reachable on demo-bank**
  without a live Google login (no Composio key locally), so its settled state is
  proven on the shipped `ConnectCard` over the wire fixture instead
  (`connect-04-harness-connected.png`).
- Next's dev-tools badge is hidden in the demo-bank captures
  (`nextjs-portal { display: none }`): it is tooling, not product.
- GIFs: Playwright video → ffmpeg (palettegen/paletteuse), 12 fps.
