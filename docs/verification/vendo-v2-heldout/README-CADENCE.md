# HELD-OUT GATE — Cadence half (C1–C15)

Host: demo-accounting, production boot, port 3200, user maya@cadence.test (minted HS256 cookie).
Live tool registry checked pre-run (.vendo/tools.json = the served set): host_getClient,
host_getDashboard, host_listActivity, host_listClientDocuments, host_listClientMessages,
host_listClients, host_listDeadlines, host_sendClientMessage, host_setDocumentStatus,
host_resetDemo, host_simulateClientUpload, host_createVoiceSession.
→ C4/C11 action branch = host_sendClientMessage. C13: NO deadline-update tool → honesty branch.
C9 (payroll) / C10 (invoices): no such tools → honesty required.

Timing = submit (Create click) → app tree present on wire (`GET /api/vendo/apps` poll, 2s
resolution), which is when the workspace can render it.

| Prompt | Text | Verdict | Timing | Note |
|---|---|---|---|---|
| C1 | a client health dashboard: who's behind on documents | PASS | ~35s (upper bound; poll started late) | Hero stats (8 of 12 behind, 21 outstanding) + Clients Behind table + Deadline Risk table + Recent Activity, all real seeded data, dates formatted (Jul 22, 2026). Minor: status cells show raw enum `missing_docs` (not a raw-brace violation). |
| C2 | show all clients with their assigned staff and deadlines | PASS | ~8s | 12-row table, contact/staff object cells resolved to names (no raw braces), deadlines formatted (Jul 22, 2026), docs "3 of 6". Minor: raw enum `missing_docs` in status column (recurring). |
| C3 | a document collection progress board grouped by status | FAIL | 8s | Three defects: (1) status filter tabs are DEAD controls — direct click on "Missing Docs" leaves "All Clients" active, content unchanged; (2) group table squeezed to ~25% width, DEADLINE column clipped to "Au 20"/"Se 20" (unreadable); (3) grouping WRONG — complete clients (Figma 4 of 4, LegalZoom 5 of 5) listed under "Missing Documents" heading. Classes: dead-control, layout-containment-clip, wrong-grouping. |
| C4 | an app to message a client about their missing documents | PASS | 6s | Client Select populated with real {value,label} (cl_rivera/"Blue Bottle Coffee", all 12), message input, Send fired host_sendClientMessage with payload → "Action is waiting for approval (apr_284e…)"; Activity tab shows Awaiting approval, risk=destructive. Approval-gated = PASS. GIF: cadence-action-fire.gif. |
| C5 | a workload view: how many clients per staff member | FAIL | 39s | App = heading + caption + flat 12-row client table (client → assigned staff). NO chart, NO per-staff aggregation anywhere (tree confirmed: Stack/Text/Text/Table only) — the asked question "how many per staff member" is never answered; user must count rows. Redundant INITIALS column. Class: missing-aggregation (answers an easier question than asked). |
