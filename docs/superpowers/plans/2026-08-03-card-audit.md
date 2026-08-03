# Card audit — evidence for lanes A/B/G (2026-08-03, rebuild/cutover)

Why cards diverge in use (verified, file:line):

1. In-thread approvals get a SYNTHESIZED descriptor with `inputSchema: {}`
   (`chrome/thread/parts.tsx:506-525`) → `declaredMoneyUnit` can't fire →
   "$47.50" renders as "4750 (unit not specified)" (`humanize.ts:108-136`,
   `core/semantics.ts:135-147`); description falls to "" so the line
   disappears; `showContext={false}`; remember-block depends on guard id.
2. Three mutually exclusive bodies in ApprovalCard (`approval-card.tsx:110-117,
   187-223`): Slack-only consequence sentence (`build-beat.tsx:89-111`),
   flat `<dl>` (1–8 primitive entries), else raw `<pre>` of inputPreview.
   Server preview = raw `tool slug + canonicalJson` capped 500
   (`guard.ts:173-176`); WaitingQueue shows ONLY that (`waiting-queue.tsx:34`).
3. Re-implementations of "the approval": WaitingRow (`waiting-queue.tsx:17`),
   voice consent strip + hand-rolled article (`voice/voice-consent.tsx:16,38`),
   embeds ResolvedApprovalCard + error article (`embeds.tsx:96,191`), sheet
   strips ALL card chrome (`chrome-css.ts:2270-2276`).
4. Composio logo CDN without onError on 3 of 4 sites (`approval-card.tsx:151`,
   `grant-set-card.tsx:33`, `morph-toast.tsx:135`; good: `connect-card.tsx:129`).
5. Developer-voice policy banner auto-prepends above top-level cards in BYO
   hosts (`chrome-root.tsx:26-29,50,67`; copy `policy-notice-body.tsx:3-9`).
6. Unmatched/dead classes: `.fl-btn--primary`/`--ghost` in share-dialog
   (`share-dialog.tsx:335,438,267,396,448`); `.fl-approval-heading` unstyled
   (5 users); `.fl-beat-working`, `.fl-ribbon--working`, `.fl-buildfail`
   unstyled; duplicate `.fl-approval-desc` (`chrome-css.ts:528,538`) and
   `.fl-approval-consequence` (`:683,1761`).
7. Dead CSS families (zero TSX consumers — verify then delete): `.fl-tool*`
   (10), `.fl-trust*` (14), `.fl-auto-created-*`, `.fl-auto-approval-*`,
   `.fl-auto-access-*`, `.fl-auto-summary*`, `.fl-connect{,-head,-ic,-done-dot}`
   dead halves, `.fl-approval-{unverified,outcome,declined,reason,--escalation}`,
   `.fl-waiting-stale`, `.fl-receipt*`.
8. Fragmentation counts: 6 hardcoded eyebrow strings; 4 field-row
   implementations; icon wells 26/28/30/32/34px; primary buttons
   `.fl-btn-primary`/`.fl-btn-ceremony`/`.fl-btn-critical`; tick SVG inlined
   5×; density/radius half-tokenized (`.fl-approval` hardcodes 14px pad;
   radius hardcoded 148×).
9. ContainedNotice reads token names themeCssVariables never emits
   (`tree/notice.tsx:3-25`) — different grey/padding inside cards.
10. No designed reference exists: `packages/ui/gallery/main.tsx` has ZERO
    cards; only `e2e/harness/main.tsx:974-980` renders one perfect fixture.
    The Playwright UI suite has pre-existing failures and is NOT in `pnpm test`.
