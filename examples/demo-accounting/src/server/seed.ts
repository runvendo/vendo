import type {
  ActivityEvent,
  Client,
  DocumentRequest,
  DocumentStatus,
  Message,
  Staff,
} from "./types"

export interface SeedData {
  staff: Staff[]
  clients: Client[]
  documents: DocumentRequest[]
  messages: Message[]
  activity: ActivityEvent[]
}

function iso(d: Date) {
  // Preserve the LOCAL wall-clock in the serialized string. toISOString()
  // shifted every 5pm-local deadline onto the next UTC day, so the model's
  // prose (which reads the raw string) narrated all deadlines +1 day.
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0")
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? "+" : "-"
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  )
}

/** n days before the anchor, at the given local time. */
function daysAgo(anchor: Date, n: number, h = 12, m = 0) {
  const d = new Date(anchor)
  d.setDate(d.getDate() - n)
  d.setHours(h, m, 0, 0)
  return d
}

/** h hours (and m minutes) before the anchor. Safe for "earlier today" events. */
function hoursAgo(anchor: Date, h: number, m = 0) {
  return new Date(anchor.getTime() - (h * 60 + m) * 60_000)
}

/** n days after the anchor, end of business. Keeps deadlines urgent but future. */
function deadline(anchor: Date, n: number) {
  const d = new Date(anchor)
  d.setDate(d.getDate() + n)
  d.setHours(17, 0, 0, 0)
  return iso(d)
}

// Staff roster for Hartwell & Associates. Maya Alvarez is the signed-in persona.
const STAFF: Staff[] = [
  { id: "st_maya", name: "Maya Alvarez", role: "Account Manager", initials: "MA" },
  { id: "st_daniel", name: "Daniel Hartwell", role: "Partner", initials: "DH" },
  { id: "st_priya", name: "Priya Natarajan", role: "Senior Accountant", initials: "PN" },
  { id: "st_tomas", name: "Tomas Okafor", role: "Bookkeeper", initials: "TO" },
]

export function buildSeed(anchor: Date = new Date()): SeedData {
  const staff = STAFF.map(s => ({ ...s }))

  // 12 clients. The first 8 have at least one missing document (the dashboard's
  // hero number); the last 4 are fully verified. Blue Bottle and Linear sit INSIDE the
  // 3-day deadline window so deadline and document-chase views have urgent
  // examples; the rest stagger out to ~10 weeks.
  //
  // Contact emails are plus-addressed to the demo Gmail account (yousef@vendo.run)
  // ON PURPOSE: approval-gated Gmail sends must land in an inbox we own — never
  // at third-party domains.
  const clients: Client[] = [
    { id: "cl_rivera", businessName: "Blue Bottle Coffee", entityType: "s_corp",
      contactName: "Marisol Rivera", contactEmail: "yousef+rivera@vendo.run",
      assigneeId: "st_maya", filingDeadline: deadline(anchor, 2) },
    { id: "cl_chen", businessName: "Linear", entityType: "sole_prop",
      contactName: "Wei Chen", contactEmail: "yousef+chen@vendo.run",
      assigneeId: "st_maya", filingDeadline: deadline(anchor, 3) },
    { id: "cl_delgado", businessName: "Sweetgreen", entityType: "partnership",
      contactName: "Antonio Delgado", contactEmail: "yousef+delgado@vendo.run",
      assigneeId: "st_maya", filingDeadline: deadline(anchor, 21) },
    { id: "cl_harborview", businessName: "Equinox", entityType: "s_corp",
      contactName: "Dana Kowalski", contactEmail: "yousef+harborview@vendo.run",
      assigneeId: "st_priya", filingDeadline: deadline(anchor, 25) },
    { id: "cl_foster", businessName: "TaskRabbit", entityType: "sole_prop",
      contactName: "Greg Foster", contactEmail: "yousef+foster@vendo.run",
      assigneeId: "st_tomas", filingDeadline: deadline(anchor, 29) },
    { id: "cl_patel", businessName: "Anjali Patel", entityType: "individual",
      contactName: "Anjali Patel", contactEmail: "yousef+patel@vendo.run",
      assigneeId: "st_maya", filingDeadline: deadline(anchor, 33) },
    { id: "cl_kim", businessName: "Compass", entityType: "partnership",
      contactName: "Susan Kim", contactEmail: "yousef+kim@vendo.run",
      assigneeId: "st_priya", filingDeadline: deadline(anchor, 38) },
    { id: "cl_cortez", businessName: "Jiffy Lube", entityType: "sole_prop",
      contactName: "Luis Cortez", contactEmail: "yousef+cortez@vendo.run",
      assigneeId: "st_tomas", filingDeadline: deadline(anchor, 43) },
    { id: "cl_lakeside", businessName: "Banfield Pet Hospital", entityType: "c_corp",
      contactName: "Emily Rhodes", contactEmail: "yousef+lakeside@vendo.run",
      assigneeId: "st_priya", filingDeadline: deadline(anchor, 49) },
    { id: "cl_whitfield", businessName: "Figma", entityType: "sole_prop",
      contactName: "Jonah Whitfield", contactEmail: "yousef+whitfield@vendo.run",
      assigneeId: "st_daniel", filingDeadline: deadline(anchor, 55) },
    { id: "cl_mercer", businessName: "LegalZoom", entityType: "partnership",
      contactName: "Alice Mercer", contactEmail: "yousef+mercer@vendo.run",
      assigneeId: "st_daniel", filingDeadline: deadline(anchor, 62) },
    { id: "cl_ellison", businessName: "Grant Ellison", entityType: "individual",
      contactName: "Grant Ellison", contactEmail: "yousef+ellison@vendo.run",
      assigneeId: "st_maya", filingDeadline: deadline(anchor, 70) },
  ]

  const documents: DocumentRequest[] = []
  const doc = (
    id: string,
    clientId: string,
    kind: string,
    status: DocumentStatus,
    file?: { name: string; daysAgo: number },
    note?: string,
  ) => {
    documents.push({
      id, clientId, kind, status,
      ...(note ? { note } : {}),
      ...(file
        ? { file: { name: file.name, uploadedAt: iso(daysAgo(anchor, file.daysAgo, 10, 24)) } }
        : {}),
    })
  }

  // Blue Bottle Coffee — the demo hero: 3 of 6 received.
  doc("doc_rivera_prior_return", "cl_rivera", "Prior-year return", "verified",
    { name: "bluebottle-2024-return.pdf", daysAgo: 21 })
  doc("doc_rivera_bank", "cl_rivera", "Bank statements (2025)", "received",
    { name: "boa-business-statements-jan-jun.pdf", daysAgo: 3 })
  doc("doc_rivera_payroll", "cl_rivera", "Payroll summary", "needs_review",
    { name: "gusto-payroll-summary-2025.pdf", daysAgo: 2 })
  doc("doc_rivera_w2", "cl_rivera", "W-2", "missing")
  doc("doc_rivera_1099", "cl_rivera", "1099-NEC", "missing")
  doc("doc_rivera_receipts", "cl_rivera", "Receipts", "missing")

  // Linear — 3 of 5.
  doc("doc_chen_prior_return", "cl_chen", "Prior-year return", "verified",
    { name: "linear-2024-return.pdf", daysAgo: 14 })
  doc("doc_chen_1099", "cl_chen", "1099-NEC", "received",
    { name: "linear-1099-nec-clients.pdf", daysAgo: 4 })
  doc("doc_chen_mileage", "cl_chen", "Mileage log", "verified",
    { name: "chen-2025-mileage-log.xlsx", daysAgo: 10 })
  doc("doc_chen_bank", "cl_chen", "Bank statements (2025)", "missing")
  doc("doc_chen_receipts", "cl_chen", "Receipts", "missing")

  // Sweetgreen — 4 of 6.
  doc("doc_delgado_prior_return", "cl_delgado", "Prior-year return", "verified",
    { name: "sweetgreen-2024-1065.pdf", daysAgo: 18 })
  doc("doc_delgado_bank", "cl_delgado", "Bank statements (2025)", "verified",
    { name: "chase-business-statements-h1.pdf", daysAgo: 9 })
  doc("doc_delgado_payroll", "cl_delgado", "Payroll summary", "received",
    { name: "adp-payroll-summary-q1-q2.pdf", daysAgo: 1 })
  doc("doc_delgado_receipts", "cl_delgado", "Receipts", "needs_review",
    { name: "vendor-receipts-scan-batch2.pdf", daysAgo: 1 })
  doc("doc_delgado_1099", "cl_delgado", "1099-NEC", "missing")
  doc("doc_delgado_w2", "cl_delgado", "W-2", "missing")

  // Equinox — 3 of 5.
  doc("doc_harborview_prior_return", "cl_harborview", "Prior-year return", "verified",
    { name: "equinox-2024-1120s.pdf", daysAgo: 12 })
  doc("doc_harborview_payroll", "cl_harborview", "Payroll summary", "verified",
    { name: "equinox-payroll-2025.pdf", daysAgo: 8 })
  doc("doc_harborview_receipts", "cl_harborview", "Receipts", "received",
    { name: "equipment-receipts-2025.pdf", daysAgo: 2 })
  doc("doc_harborview_bank", "cl_harborview", "Bank statements (2025)", "missing")
  doc("doc_harborview_w2", "cl_harborview", "W-2", "missing")

  // TaskRabbit — 1 of 4, furthest behind.
  doc("doc_foster_prior_return", "cl_foster", "Prior-year return", "received",
    { name: "taskrabbit-2024-return-scan.pdf", daysAgo: 5 })
  doc("doc_foster_1099", "cl_foster", "1099-NEC", "missing")
  doc("doc_foster_bank", "cl_foster", "Bank statements (2025)", "missing")
  doc("doc_foster_receipts", "cl_foster", "Receipts", "missing")

  // Anjali Patel — 2 of 4.
  doc("doc_patel_w2", "cl_patel", "W-2", "verified",
    { name: "patel-w2-northgate-medical.pdf", daysAgo: 16 })
  doc("doc_patel_prior_return", "cl_patel", "Prior-year return", "verified",
    { name: "patel-2024-1040.pdf", daysAgo: 16 })
  doc("doc_patel_1099", "cl_patel", "1099-NEC", "missing")
  doc("doc_patel_receipts", "cl_patel", "Receipts", "missing")

  // Compass — 2 of 5.
  doc("doc_kim_prior_return", "cl_kim", "Prior-year return", "verified",
    { name: "compass-2024-1065.pdf", daysAgo: 20 })
  doc("doc_kim_bank", "cl_kim", "Bank statements (2025)", "received",
    { name: "wells-fargo-statements-jan-jun.pdf", daysAgo: 6 })
  doc("doc_kim_payroll", "cl_kim", "Payroll summary", "missing")
  doc("doc_kim_1099", "cl_kim", "1099-NEC", "missing")
  doc("doc_kim_receipts", "cl_kim", "Receipts", "missing")

  // Jiffy Lube — 1 of 5. Receipts were rejected once and re-uploaded.
  doc("doc_cortez_receipts", "cl_cortez", "Receipts", "received",
    { name: "shop-receipts-2025-resubmitted.pdf", daysAgo: 4 })
  doc("doc_cortez_prior_return", "cl_cortez", "Prior-year return", "missing")
  doc("doc_cortez_bank", "cl_cortez", "Bank statements (2025)", "missing",
    undefined, "Personal checking statement was uploaded; need the business account.")
  doc("doc_cortez_1099", "cl_cortez", "1099-NEC", "missing")
  doc("doc_cortez_payroll", "cl_cortez", "Payroll summary", "missing")

  // Banfield Pet Hospital — complete.
  doc("doc_lakeside_prior_return", "cl_lakeside", "Prior-year return", "verified",
    { name: "banfield-2024-1120.pdf", daysAgo: 35 })
  doc("doc_lakeside_bank", "cl_lakeside", "Bank statements (2025)", "verified",
    { name: "banfield-usbank-statements-h1.pdf", daysAgo: 11 })
  doc("doc_lakeside_payroll", "cl_lakeside", "Payroll summary", "verified",
    { name: "banfield-adp-payroll-2025.pdf", daysAgo: 11 })
  doc("doc_lakeside_w2", "cl_lakeside", "W-2", "verified",
    { name: "banfield-w2-batch-2025.pdf", daysAgo: 13 })
  doc("doc_lakeside_1099", "cl_lakeside", "1099-NEC", "verified",
    { name: "banfield-1099-nec-contractors.pdf", daysAgo: 13 })
  doc("doc_lakeside_receipts", "cl_lakeside", "Receipts", "verified",
    { name: "banfield-expense-receipts-2025.pdf", daysAgo: 10 })

  // Figma — complete.
  doc("doc_whitfield_prior_return", "cl_whitfield", "Prior-year return", "verified",
    { name: "figma-2024-return.pdf", daysAgo: 28 })
  doc("doc_whitfield_bank", "cl_whitfield", "Bank statements (2025)", "verified",
    { name: "mercury-statements-jan-jun.pdf", daysAgo: 17 })
  doc("doc_whitfield_1099", "cl_whitfield", "1099-NEC", "verified",
    { name: "figma-1099s-2025.pdf", daysAgo: 17 })
  doc("doc_whitfield_receipts", "cl_whitfield", "Receipts", "verified",
    { name: "studio-expense-receipts.pdf", daysAgo: 15 })

  // LegalZoom — complete.
  doc("doc_mercer_prior_return", "cl_mercer", "Prior-year return", "verified",
    { name: "legalzoom-2024-1065.pdf", daysAgo: 30 })
  doc("doc_mercer_bank", "cl_mercer", "Bank statements (2025)", "verified",
    { name: "legalzoom-statements-h1.pdf", daysAgo: 19 })
  doc("doc_mercer_payroll", "cl_mercer", "Payroll summary", "verified",
    { name: "legalzoom-payroll-2025.pdf", daysAgo: 19 })
  doc("doc_mercer_w2", "cl_mercer", "W-2", "verified",
    { name: "legalzoom-w2s.pdf", daysAgo: 22 })
  doc("doc_mercer_receipts", "cl_mercer", "Receipts", "verified",
    { name: "firm-expense-receipts-2025.pdf", daysAgo: 18 })

  // Grant Ellison — complete.
  doc("doc_ellison_w2", "cl_ellison", "W-2", "verified",
    { name: "ellison-w2-meridian-labs.pdf", daysAgo: 26 })
  doc("doc_ellison_prior_return", "cl_ellison", "Prior-year return", "verified",
    { name: "ellison-2024-1040.pdf", daysAgo: 26 })
  doc("doc_ellison_1099", "cl_ellison", "1099-NEC", "verified",
    { name: "ellison-1099-nec-consulting.pdf", daysAgo: 24 })
  doc("doc_ellison_receipts", "cl_ellison", "Receipts", "verified",
    { name: "ellison-donation-receipts.pdf", daysAgo: 23 })

  const messages: Message[] = []
  let msgN = 0
  const msg = (
    clientId: string,
    direction: Message["direction"],
    author: string,
    body: string,
    d: number,
    h: number,
    m = 0,
  ) => {
    messages.push({
      id: `msg_${String(++msgN).padStart(3, "0")}`,
      clientId, direction, author, body,
      sentAt: iso(daysAgo(anchor, d, h, m)),
    })
  }

  msg("cl_rivera", "firm", "Maya Alvarez",
    "Hi Marisol, kicking off your 2025 filing. We still need your January-June bank statements, owner W-2, any 1099-NECs you issued to crews, and expense receipts. The secure upload link is in your portal.",
    6, 10, 12)
  msg("cl_rivera", "client", "Marisol Rivera",
    "Just uploaded the Bank of America statements through June. Still tracking down the 1099s, our old bookkeeper had those on file.",
    3, 14, 41)
  msg("cl_rivera", "firm", "Maya Alvarez",
    "Got the statements, thank you. The Gusto payroll summary is under review; it looks like Q1 may be cut off, so I will confirm shortly.",
    2, 9, 55)
  msg("cl_rivera", "client", "Marisol Rivera",
    "Thanks Maya. I should have the 1099-NECs from Miguel by Friday and will send the receipts folder with them.",
    1, 16, 8)

  msg("cl_chen", "firm", "Maya Alvarez",
    "Hi Wei, your prior-year return and mileage log are verified. Once we have your business bank statements and expense receipts we can start the draft.",
    5, 11, 20)
  msg("cl_chen", "client", "Wei Chen",
    "Uploaded the 1099-NECs from my two retainer clients. Chase is being slow with the statement export; I will send those this week.",
    4, 15, 2)
  msg("cl_chen", "firm", "Maya Alvarez",
    "Perfect, the 1099s are in. No rush on the receipts, but statements by next week keeps us comfortably ahead of your deadline.",
    4, 16, 30)

  msg("cl_delgado", "firm", "Maya Alvarez",
    "Antonio, thanks for the Chase statements. Remaining items for the partnership return: ADP payroll summary, W-2s for kitchen staff, and 1099-NECs for the delivery contractors.",
    7, 9, 45)
  msg("cl_delgado", "client", "Antonio Delgado",
    "Payroll summary from ADP just went up, both quarters. The receipts batch I sent yesterday has a few personal items mixed in, sorry about that.",
    1, 12, 17)
  msg("cl_delgado", "firm", "Maya Alvarez",
    "No problem, I flagged the receipts batch for review and will pull out anything personal. W-2s and 1099s are the last two items.",
    1, 13, 5)
  msg("cl_delgado", "client", "Antonio Delgado",
    "Our payroll company said the W-2 file goes out Monday. I will forward it the moment it lands.",
    1, 18, 42)

  msg("cl_harborview", "firm", "Priya Natarajan",
    "Hi Dana, your return and payroll summary are verified. Still open: business bank statements for 2025 and owner W-2. Equipment receipts came through and are in review.",
    2, 10, 5)
  msg("cl_harborview", "client", "Dana Kowalski",
    "Thanks Priya. Requesting the statements from the bank today; the W-2 should come with our payroll package next week.",
    2, 12, 33)

  msg("cl_foster", "firm", "Tomas Okafor",
    "Greg, we received the scan of your 2024 return and it is in review. To move forward we need your 1099-NECs, business bank statements, and job expense receipts.",
    5, 9, 12)
  msg("cl_foster", "client", "Greg Foster",
    "Been slammed with jobs this month. I will get the bank statements downloaded this weekend, receipts are in a shoebox as usual.",
    3, 19, 4)
  msg("cl_foster", "firm", "Tomas Okafor",
    "Understood. Photos of the receipts through the portal are fine, no need to organize them first. The statements are the critical piece.",
    3, 19, 30)

  msg("cl_patel", "firm", "Maya Alvarez",
    "Hi Anjali, your W-2 and prior-year return are verified. Last items are the 1099-NEC from your consulting work and donation receipts if you want to itemize.",
    6, 13, 25)
  msg("cl_patel", "client", "Anjali Patel",
    "The consulting platform says 1099s are available mid-month, I will download it as soon as it posts. Gathering donation receipts now.",
    5, 8, 48)

  msg("cl_kim", "firm", "Priya Natarajan",
    "Susan, the Wells Fargo statements arrived and are in review. For the partnership return we still need the payroll summary, 1099-NECs for photographers, and expense receipts.",
    6, 10, 55)
  msg("cl_kim", "client", "Susan Kim",
    "Our office manager is pulling the payroll report from QuickBooks. Should have it plus the 1099s to you by end of week.",
    5, 14, 21)
  msg("cl_kim", "firm", "Priya Natarajan",
    "Sounds good. A reminder will go out from the portal if anything is still open on Monday.",
    5, 15, 2)

  msg("cl_cortez", "firm", "Tomas Okafor",
    "Luis, quick heads-up: the bank statement you uploaded was for your personal checking account. We need statements for the business account ending 4417.",
    8, 11, 40)
  msg("cl_cortez", "client", "Luis Cortez",
    "My mistake, wrong download. Re-sent the shop receipts too since the first scan was blurry. Business statements coming after I call the bank.",
    4, 13, 15)
  msg("cl_cortez", "firm", "Tomas Okafor",
    "The resubmitted receipts look good. Once the business statements and prior-year return are in we can schedule your review call.",
    4, 14, 2)

  msg("cl_lakeside", "firm", "Priya Natarajan",
    "Emily, everything for the clinic is in and verified. We will have a draft of the corporate return to you well ahead of the deadline.",
    9, 10, 10)
  msg("cl_lakeside", "client", "Emily Rhodes",
    "Wonderful, thank you for making this painless. Looking forward to the draft.",
    9, 11, 26)

  msg("cl_mercer", "firm", "Daniel Hartwell",
    "Alice, your document checklist is complete and verified. Priya starts on the partnership return this week; expect a draft in about ten days.",
    16, 15, 45)
  msg("cl_mercer", "client", "Alice Mercer",
    "Great news. Flag anything on the partner distributions early if it needs discussion.",
    16, 17, 3)

  const activity: ActivityEvent[] = [
    { id: "act_001", type: "deadline_approaching", clientId: "cl_rivera",
      summary: "Blue Bottle Coffee filing deadline is 2 days out with 3 documents missing",
      at: iso(hoursAgo(anchor, 1, 10)) },
    { id: "act_002", type: "upload_received", clientId: "cl_delgado",
      summary: "Antonio Delgado uploaded Payroll summary (adp-payroll-summary-q1-q2.pdf)",
      at: iso(daysAgo(anchor, 1, 12, 10)) },
    { id: "act_003", type: "message_sent", clientId: "cl_rivera",
      summary: "Marisol Rivera replied about the outstanding 1099-NECs",
      at: iso(daysAgo(anchor, 1, 16, 8)) },
    { id: "act_004", type: "upload_received", clientId: "cl_rivera",
      summary: "Marisol Rivera uploaded Payroll summary (gusto-payroll-summary-2025.pdf)",
      at: iso(daysAgo(anchor, 2, 10, 24)) },
    { id: "act_005", type: "upload_received", clientId: "cl_harborview",
      summary: "Dana Kowalski uploaded Receipts (equipment-receipts-2025.pdf)",
      at: iso(daysAgo(anchor, 2, 10, 24)) },
    { id: "act_006", type: "upload_received", clientId: "cl_rivera",
      summary: "Marisol Rivera uploaded Bank statements (boa-business-statements-jan-jun.pdf)",
      at: iso(daysAgo(anchor, 3, 14, 41)) },
    { id: "act_007", type: "document_verified", clientId: "cl_kim",
      summary: "Prior-year return verified for Compass",
      at: iso(daysAgo(anchor, 4, 9, 30)) },
    { id: "act_008", type: "upload_received", clientId: "cl_cortez",
      summary: "Luis Cortez re-uploaded Receipts (shop-receipts-2025-resubmitted.pdf)",
      at: iso(daysAgo(anchor, 4, 13, 15)) },
    { id: "act_009", type: "document_rejected", clientId: "cl_cortez",
      summary: "Bank statements rejected for Jiffy Lube: personal account uploaded instead of business",
      at: iso(daysAgo(anchor, 8, 11, 40)) },
    { id: "act_010", type: "document_verified", clientId: "cl_lakeside",
      summary: "Final document verified for Banfield Pet Hospital; checklist complete",
      at: iso(daysAgo(anchor, 10, 15, 20)) },
  ]
  activity.sort((a, b) => +new Date(b.at) - +new Date(a.at))

  return { staff, clients, documents, messages, activity }
}
