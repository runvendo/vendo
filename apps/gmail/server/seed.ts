/**
 * Seed mailbox for the Gmail clone — the single source of truth the frontend
 * previously kept in src/data.js, upgraded to full messages: real sender
 * addresses, ISO timestamps (Pacific offsets), unread flags, and complete
 * bodies for the messages the demo acts on. Everything is fiction set in
 * July 2026; the account owner is Yousef at Acme Labs.
 */
import type { MailAddress, MailMessage } from "./store";

export const DEMO_ME: MailAddress = { name: "Yousef", email: "yousef@acmelabs.dev" };

interface SeedEntry {
  name: string;
  email: string;
  subject: string;
  body: string;
  date: string;
  unread?: boolean;
  starred?: boolean;
}

const INBOX: SeedEntry[] = [
  {
    name: "Sarah Kim",
    email: "sarah.kim@acmelabs.dev",
    subject: "Re: Q3 planning doc — comments inside",
    body:
      "Left a few comments on the roadmap section. Biggest one: I think we should pull the billing migration forward a sprint — the current sequencing leaves us exposed if usage keeps growing at the June rate.\n\nAlso flagged the staffing line for the platform team; the doc still shows the old headcount. Can you take a pass before our 1:1 on Wednesday? I want to lock this by Friday.\n\n— Sarah",
    date: "2026-07-02T10:42:00-07:00",
    unread: true,
  },
  {
    name: "GitHub",
    email: "notifications@github.com",
    subject: "[acme/platform] PR #482: Fix race condition in webhook retries (merged)",
    body:
      "Merged #482 into main.\n\n12 files changed, 214 additions and 96 deletions. All checks have passed.\n\nMarcus Delgado merged this pull request. The retry scheduler now takes the delivery lock before re-enqueueing, closing the double-send window under concurrent retries.\n\nView it on GitHub or reply to this email to comment.",
    date: "2026-07-02T09:58:00-07:00",
    unread: true,
  },
  {
    name: "Google Calendar",
    email: "calendar-notification@google.com",
    subject: "Invitation: Design review @ Thu Jul 2, 2pm — 3pm (PDT)",
    body:
      "Priya Natarajan has invited you to Design review.\n\nThursday Jul 2, 2026 · 2:00 – 3:00pm Pacific Time\nLocation: Yosemite / Meet link attached\n\nAgenda: onboarding flow v3 walkthrough, open questions on the integrations tab, next steps for the Q3 concepts file.\n\nGoing? Yes / Maybe / No",
    date: "2026-07-02T09:14:00-07:00",
    unread: true,
  },
  {
    name: "Stripe",
    email: "receipts@stripe.com",
    subject: "Your invoice from Linear (July 2026) — $384.00",
    body:
      "Receipt from Linear, Inc.\n\nAmount paid: $384.00\nPaid: Jul 1, 2026\nPlan: Workspace, 32 seats × $12.00\nInvoice number: LIN-2026-07-0031\n\nDownload your invoice or view your billing history from the billing portal.",
    date: "2026-07-02T08:31:00-07:00",
    unread: true,
  },
  {
    name: "Marcus Delgado",
    email: "marcus@acmelabs.dev",
    subject: "Offsite agenda — need your session by EOD",
    body:
      "Hey — locking the offsite agenda tonight. You're down for the 45-min architecture walkthrough on day 2.\n\nCan you send me a one-line description and any prep the team should do beforehand? Even rough is fine, I just need something for the printed agenda.\n\nIf I don't hear back by EOD I'll write something embarrassing on your behalf.\n\n— M",
    date: "2026-07-01T18:20:00-07:00",
    unread: true,
  },
  {
    name: "Vercel",
    email: "notifications@vercel.com",
    subject: "Deployment failed: acme-web (production)",
    body:
      "Your deployment acme-web-git-main failed to build.\n\nError: Command \"pnpm build\" exited with 1.\nFailing step: next build — type error in src/lib/pricing.ts (Property 'tier' does not exist on type 'Plan').\n\nThis affects the production alias acme-web.vercel.app, which is still serving the previous deployment. Check the build logs for details.",
    date: "2026-07-01T16:05:00-07:00",
    unread: true,
  },
  {
    name: "Linear",
    email: "updates@linear.app",
    subject: "Weekly digest: 14 issues completed, 6 added in Platform",
    body:
      "Your team shipped 14 issues last week. Cycle 23 is 68% complete with 3 days remaining. At-risk: ENG-1247 (blocked 4 days), ENG-1252 (no assignee).",
    date: "2026-07-01T13:45:00-07:00",
  },
  {
    name: "Priya Natarajan",
    email: "priya@acmelabs.dev",
    subject: "Figma updated — onboarding flow v3",
    body:
      "Third pass on the onboarding flow is up. Killed the carousel like we discussed — first-run is now a single checklist, and the empty states finally have real copy.\n\nTake a look before Thursday's review so we can spend the hour on the integrations tab instead of re-litigating the checklist. Link is in the usual project.\n\n— P",
    date: "2026-07-01T09:30:00-07:00",
    unread: true,
  },
  {
    name: "AWS Billing",
    email: "no-reply@aws.amazon.com",
    subject: "Your AWS bill for June 2026 is available — $2,847.19",
    body:
      "Your invoice for the billing period June 1 – June 30, 2026 is now available. Total: $2,847.19. Top services: EC2 $1,204.55, RDS $688.02, S3 $301.44.",
    date: "2026-07-01T07:10:00-07:00",
  },
  {
    name: "Datadog",
    email: "alerts@datadoghq.com",
    subject: "[Triggered] p95 latency > 800ms on api-gateway",
    body:
      "Monitor p95 latency api-gateway triggered at 06:14 UTC. Current value: 1,240ms over threshold 800ms for the last 10 minutes. Affected env: production.",
    date: "2026-06-30T23:14:00-07:00",
  },
  {
    name: "Jenny Park (Greenhouse)",
    email: "no-reply@greenhouse.io",
    subject: "Interview confirmed: Staff Engineer candidate, Fri 11am",
    body:
      "You're confirmed for the systems design interview with Daniel Osei on Friday Jul 3, 11:00–12:00. Scorecard and resume are linked. Please submit feedback within 24 hours of the interview.",
    date: "2026-06-30T16:40:00-07:00",
  },
  {
    name: "Notion",
    email: "notify@mail.notion.so",
    subject: "Alex mentioned you in \"Incident retro: 6/28 checkout outage\"",
    body:
      "Alex Rivera mentioned you: \"@you can you own the follow-up on connection pool limits? Marking you on action item 3.\" Open in Notion to reply.",
    date: "2026-06-30T14:05:00-07:00",
  },
  {
    name: "The Pragmatic Engineer",
    email: "newsletter@pragmaticengineer.com",
    subject: "The Pulse #147: What the Figma IPO filing reveals",
    body:
      "Welcome to The Pulse. In this issue: Figma's S-1 numbers in context, why mid-size startups are re-bundling infra, and notes on the July hiring market.",
    date: "2026-06-30T08:20:00-07:00",
  },
  {
    name: "Slack",
    email: "notifications@slack.com",
    subject: "You have 3 mentions in #eng-platform",
    body:
      "While you were away: Marcus mentioned you in a thread about the webhook retry fix, and 2 more mentions in #eng-platform. Catch up in Slack.",
    date: "2026-06-29T19:45:00-07:00",
  },
  {
    name: "Sarah Kim",
    email: "sarah.kim@acmelabs.dev",
    subject: "Intro: Tomás from Meridian Ventures",
    body:
      "Connecting you two — Tomás is doing a deep dive on dev-tools infra and I mentioned the migration work your team did last quarter. Tomás, meet the person who actually did it. I'll let you two take it from here.",
    date: "2026-06-29T15:10:00-07:00",
  },
  {
    name: "United Airlines",
    email: "unitedairlines@united.com",
    subject: "Your trip confirmation — SFO ⇄ AUS, Jul 14",
    body:
      "Confirmation #KX4R2N. San Francisco (SFO) to Austin (AUS), Tue Jul 14 departing 8:05 AM, seat 21C. Return Thu Jul 16 arriving 9:40 PM. Check in 24 hours before departure.",
    date: "2026-06-29T11:30:00-07:00",
    starred: true,
  },
  {
    name: "GitHub",
    email: "notifications@github.com",
    subject: "[acme/platform] Review requested on PR #479: Extract rate limiter into middleware",
    body:
      "Marcus Delgado requested your review on #479. \"Pulls the token-bucket logic out of the gateway handler so the cron service can reuse it. Mostly mechanical.\"",
    date: "2026-06-28T17:25:00-07:00",
  },
  {
    name: "Google Cloud",
    email: "billing-alerts@google.com",
    subject: "Your project 'acme-staging' exceeded 80% of budget",
    body:
      "Budget alert: acme-staging has used $812.44 of your $1,000.00 monthly budget. At the current rate you will exceed the budget before the end of the period.",
    date: "2026-06-28T13:50:00-07:00",
  },
  {
    name: "Alex Rivera",
    email: "alex.rivera@acmelabs.dev",
    subject: "Retro doc + action items from the checkout outage",
    body:
      "Retro is written up. TL;DR: connection pool exhaustion under the flash-sale spike, masked by the retry storm. Five action items, three owned, two need owners — one of them has your name pencilled in.",
    date: "2026-06-28T09:15:00-07:00",
  },
  {
    name: "Figma",
    email: "notifications@figma.com",
    subject: "Priya invited you to \"Mobile app — Q3 concepts\"",
    body:
      "Priya Natarajan invited you to edit the file Mobile app — Q3 concepts. Open in Figma to view the latest frames and leave feedback.",
    date: "2026-06-27T16:35:00-07:00",
  },
  {
    name: "Chase",
    email: "no-reply@chase.com",
    subject: "Your statement is ready — account ending 4417",
    body:
      "Your June statement for the account ending in 4417 is now available. Statement balance: $3,208.77. Payment due Jul 25. View your statement online.",
    date: "2026-06-27T10:05:00-07:00",
  },
  {
    name: "Lenny's Newsletter",
    email: "lenny@substack.com",
    subject: "How the best PMs run launch reviews",
    body:
      "This week: a tactical guide to launch reviews — the pre-mortem template, who should be in the room, and the single question that kills weak launches early.",
    date: "2026-06-26T15:20:00-07:00",
  },
  {
    name: "Marcus Delgado",
    email: "marcus@acmelabs.dev",
    subject: "Re: rate limiter PR — good catch, fixed",
    body:
      "You were right about the burst window math — off by a factor of the refill interval. Pushed a fix with a regression test. Should be green now, mind re-approving?",
    date: "2026-06-26T11:40:00-07:00",
  },
  {
    name: "Zoom",
    email: "no-reply@zoom.us",
    subject: "Cloud recording ready: Eng All-Hands (Jun 25)",
    body:
      "Your cloud recording is ready. Eng All-Hands — Jun 25, 2026, 58 minutes. Topics: H2 priorities, platform team re-org, Q&A. View or share the recording.",
    date: "2026-06-25T17:55:00-07:00",
  },
  {
    name: "Anna Liu",
    email: "anna.liu@gmail.com",
    subject: "Dinner Thursday? New ramen place on Valencia",
    body:
      "It finally opened! The one we walked past in March. I'm thinking 7:30 Thursday — they don't take reservations but the line moves fast apparently. You in?",
    date: "2026-06-25T12:10:00-07:00",
  },
  {
    name: "npm",
    email: "support@npmjs.com",
    subject: "Security advisory affecting 2 of your projects",
    body:
      "A high-severity advisory (GHSA-73xr) was published for fast-xml-parser < 4.4.1. Dependabot has opened pull requests in acme/platform and acme/cron-service.",
    date: "2026-06-24T14:30:00-07:00",
  },
  {
    name: "Google Calendar",
    email: "calendar-notification@google.com",
    subject: "Updated invitation: 1:1 with Sarah — now Wed 3pm",
    body:
      "Sarah Kim updated the event 1:1 Sarah / you. Changed: time — now Wednesday 3:00 – 3:30pm weekly. Note: \"moving to avoid the design review conflict.\"",
    date: "2026-06-24T09:45:00-07:00",
  },
  {
    name: "Substack",
    email: "newsletter@substack.com",
    subject: "Money Stuff: The index fund that ate the market",
    body:
      "Matt Levine on what happens when passive isn't passive anymore, plus SEC comment letters, a crypto footnote, and the usual disclaimers about nothing being investment advice.",
    date: "2026-06-23T16:15:00-07:00",
  },
  {
    name: "HR @ Acme",
    email: "hr@acmelabs.dev",
    subject: "Open enrollment closes Friday — action required",
    body:
      "Reminder: benefits open enrollment closes Friday Jun 26 at 5pm PT. If you take no action your current elections roll over, except FSA contributions which reset to zero.",
    date: "2026-06-23T10:30:00-07:00",
  },
  {
    name: "Jenny Park (Greenhouse)",
    email: "no-reply@greenhouse.io",
    subject: "Scorecard reminder: feedback due for Daniel Osei",
    body:
      "Friendly reminder to submit your interview scorecard for Daniel Osei (Staff Engineer). Feedback is due within 24 hours of the interview to keep the loop on schedule.",
    date: "2026-06-22T15:50:00-07:00",
  },
  {
    name: "Delta Dental",
    email: "reminders@deltadental.com",
    subject: "Appointment reminder: cleaning on Jul 8, 9:00 AM",
    body:
      "This is a reminder of your upcoming appointment with Dr. Feldman on Wednesday, Jul 8 at 9:00 AM. Reply C to confirm or call our office to reschedule.",
    date: "2026-06-22T09:00:00-07:00",
  },
  {
    name: "GitHub",
    email: "notifications@github.com",
    subject: "[acme/platform] Nightly build failed on main",
    body:
      "Workflow nightly-e2e failed on main. 2 of 214 tests failed: checkout_flow_spec (timeout), webhook_retry_spec (flaky, retried twice). View the run for logs.",
    date: "2026-06-21T22:40:00-07:00",
  },
  {
    name: "Airbnb",
    email: "automated@airbnb.com",
    subject: "Your reservation in Austin is confirmed",
    body:
      "You're going to Austin! Entire loft hosted by Camille, Jul 14 – 16. Check-in after 3:00 PM. Confirmation code HMKQ8Z. Your host will send check-in details before your trip.",
    date: "2026-06-21T13:20:00-07:00",
  },
  {
    name: "Anna Liu",
    email: "anna.liu@gmail.com",
    subject: "Photos from the weekend",
    body:
      "Finally pulled these off my camera — the ones from Point Reyes came out great, especially the lighthouse ones at golden hour. Shared album link inside.",
    date: "2026-06-20T18:05:00-07:00",
  },
  {
    name: "Product Hunt Daily",
    email: "hello@producthunt.com",
    subject: "The 10 best products of June",
    body:
      "Our monthly roundup: an open-source Retool alternative tops the list, plus an on-device transcription app and a surprisingly good CLI for managing feature flags.",
    date: "2026-06-20T07:30:00-07:00",
  },
  {
    name: "DoorDash",
    email: "no-reply@doordash.com",
    subject: "Your order from Souvla is on the way",
    body:
      "Estimated arrival 12:40 PM. Your Dasher, Miguel, picked up your order: 1× Lamb salad, 1× Greek fries, 1× Frozen Greek yogurt. Track your order live.",
    date: "2026-06-19T12:15:00-07:00",
  },
  {
    name: "Alex Rivera",
    email: "alex.rivera@acmelabs.dev",
    subject: "Can you cover on-call Jul 4 weekend?",
    body:
      "I know it's a big ask — Maya's wedding is that weekend and I'm officiating. I'll take your Jul 18 rotation plus one floater. Traffic should be quiet with the holiday freeze.",
    date: "2026-06-19T09:50:00-07:00",
  },
  {
    name: "LinkedIn",
    email: "messages-noreply@linkedin.com",
    subject: "You have 4 new invitations and a message from a recruiter",
    body:
      "Rachel T., Technical Sourcer at a stealth AI infrastructure startup: \"Your work on high-throughput webhook systems caught our eye — open to a quick chat this week?\"",
    date: "2026-06-18T14:45:00-07:00",
  },
  {
    name: "Google Domains",
    email: "domains-noreply@google.com",
    subject: "Renewal notice: acmelabs.dev renews Jul 15",
    body:
      "Your domain acmelabs.dev will automatically renew on Jul 15, 2026 for $12.00. No action is needed. Manage auto-renew settings in your account.",
    date: "2026-06-18T08:10:00-07:00",
  },
  {
    name: "Sarah Kim",
    email: "sarah.kim@acmelabs.dev",
    subject: "Board deck — final numbers section for review",
    body:
      "Last pass before this goes out tomorrow morning. Can you sanity-check slides 14–17? Specifically the infra cost trend line — want to make sure the June numbers match finance's.",
    date: "2026-06-17T19:30:00-07:00",
    starred: true,
  },
  {
    name: "Strava",
    email: "no-reply@strava.com",
    subject: "Your June recap: 87.4 miles, 12 activities",
    body:
      "Strong month! You ran 87.4 miles across 12 activities, up 18% from May. Longest run: 13.2 miles on Jun 14. You earned 3 new achievements.",
    date: "2026-06-17T10:20:00-07:00",
  },
  {
    name: "Cloudflare",
    email: "noreply@notify.cloudflare.com",
    subject: "Unusual traffic spike on api.acmelabs.dev",
    body:
      "We detected a traffic anomaly: requests to api.acmelabs.dev increased 640% between 02:00–02:20 UTC, mitigated by rate limiting rules. No action required.",
    date: "2026-06-16T15:40:00-07:00",
  },
  {
    name: "Marcus Delgado",
    email: "marcus@acmelabs.dev",
    subject: "Postgres 17 upgrade plan — draft",
    body:
      "Wrote up the staging-first plan we talked about: logical replication to a 17 replica, cutover window Sunday 6am, rollback is DNS flip back to the 15 primary.",
    date: "2026-06-16T11:05:00-07:00",
  },
  {
    name: "Ticketmaster",
    email: "customer_support@ticketmaster.com",
    subject: "Your tickets: LCD Soundsystem at the Greek Theatre",
    body:
      "You're going! LCD Soundsystem, Sat Aug 22, 8:00 PM, Greek Theatre Berkeley, Sec B Row 12 Seats 107–108. Tickets are in your account and transfer is enabled.",
    date: "2026-06-15T16:50:00-07:00",
  },
  {
    name: "Priya Natarajan",
    email: "priya@acmelabs.dev",
    subject: "User interviews — 3 clips you should watch",
    body:
      "Cut down Tuesday's sessions to the parts that matter: two users completely missed the integrations tab, one called the settings page \"a filing cabinet from 2009\". Clips linked.",
    date: "2026-06-15T09:25:00-07:00",
  },
  {
    name: "1Password",
    email: "support@1password.com",
    subject: "New sign-in to your account from Mac (San Francisco)",
    body:
      "We noticed a new sign-in to your 1Password account from a Mac in San Francisco, CA at 8:12 AM PDT. If this was you, no action is needed.",
    date: "2026-06-14T08:12:00-07:00",
  },
  {
    name: "The Information",
    email: "hello@theinformation.com",
    subject: "Exclusive: Inside the scramble to secure GPU capacity for 2027",
    body:
      "Cloud providers are quietly rewriting capacity contracts as demand forecasts for 2027 blow past supply. Plus: a major fintech explores a sale, and our weekend read.",
    date: "2026-06-13T17:35:00-07:00",
  },
  {
    name: "REI Co-op",
    email: "gearmail@rei.com",
    subject: "Your order has shipped — arriving Jun 17",
    body:
      "Good news! Your order #R2044817 has shipped: Trail-running vest (M), 2× energy gel variety pack. Track your package. Estimated delivery Wednesday Jun 17.",
    date: "2026-06-13T09:40:00-07:00",
  },
  {
    name: "Google",
    email: "no-reply@accounts.google.com",
    subject: "Security alert: new sign-in on Pixel 9",
    body:
      "New sign-in to your Google Account on Pixel 9. If this was you, you don't need to do anything. If not, we'll help you secure your account.",
    date: "2026-06-12T19:15:00-07:00",
  },
  {
    name: "Kickstarter",
    email: "no-reply@kickstarter.com",
    subject: "Project update #12: Split ergonomic keyboard — shipping begins!",
    body:
      "We're finally in production! First 500 units ship this week, backers 501–2,000 in early August. Full timeline and a factory video inside this update.",
    date: "2026-06-12T11:00:00-07:00",
  },
  {
    name: "Waymo",
    email: "receipts@waymo.com",
    subject: "Your trip receipt — $18.40",
    body:
      "Thanks for riding! Jun 11, 6:22 PM, Mission St to Hayes Valley, 2.8 miles, 14 minutes. Total charged: $18.40 to card ending 4417. Rate your trip.",
    date: "2026-06-11T18:30:00-07:00",
  },
];

interface SentEntry {
  to: MailAddress;
  subject: string;
  body: string;
  date: string;
}

const SENT: SentEntry[] = [
  {
    to: { name: "Alex Rivera", email: "alex.rivera@acmelabs.dev" },
    subject: "Re: Can you cover on-call Jul 4 weekend?",
    body:
      "Done — I'll take the Jul 4 weekend, you take my Jul 18 plus the floater. Congrats on officiating, don't drop the rings.",
    date: "2026-06-19T11:20:00-07:00",
  },
  {
    to: { name: "Marcus Delgado", email: "marcus@acmelabs.dev" },
    subject: "Re: Postgres 17 upgrade plan — draft",
    body:
      "Plan looks solid. Two asks: rehearse the cutover on staging with production-sized data first, and let's pin the rollback DNS TTL down to 60s the week before.",
    date: "2026-06-16T14:10:00-07:00",
  },
];

const snippet = (body: string): string => {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 140).trimEnd()}…` : flat;
};

export function seedMessages(): MailMessage[] {
  const inbox = INBOX.map((e, i): MailMessage => ({
    id: `m${i + 1}`,
    from: { name: e.name, email: e.email },
    to: [DEMO_ME],
    subject: e.subject,
    body: e.body,
    snippet: snippet(e.body),
    date: e.date,
    folder: "inbox",
    starred: e.starred ?? false,
    unread: e.unread ?? false,
  }));
  const sent = SENT.map((e, i): MailMessage => ({
    id: `seed-sent-${i + 1}`,
    from: { ...DEMO_ME },
    to: [e.to],
    subject: e.subject,
    body: e.body,
    snippet: snippet(e.body),
    date: e.date,
    folder: "sent",
    starred: false,
    unread: false,
  }));
  return [...inbox, ...sent];
}
