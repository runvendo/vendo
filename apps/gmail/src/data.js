const NAME_DATA = [
  {
    id: 1,
    name: "Sarah Kim",
    title: "Re: Q3 planning doc — comments inside",
    body:
      "Left a few comments on the roadmap section. Biggest one: I think we should pull the billing migration forward a sprint, the current sequencing leaves us exposed if",
    date: "10:42 AM",
  },
  {
    id: 2,
    name: "GitHub",
    title: "[acme/platform] PR #482: Fix race condition in webhook retries (merged)",
    body:
      "Merged #482 into main. 12 files changed, 214 additions and 96 deletions. All checks have passed. View it on GitHub or reply to this email to comment.",
    date: "9:58 AM",
  },
  {
    id: 3,
    name: "Google Calendar",
    title: "Invitation: Design review @ Thu Jul 2, 2pm — 3pm (PDT)",
    body:
      "Priya Natarajan has invited you to Design review. Thursday Jul 2, 2026 · 2:00 – 3:00pm Pacific Time. Location: Yosemite / Meet link attached. Going?",
    date: "9:14 AM",
  },
  {
    id: 4,
    name: "Stripe",
    title: "Your invoice from Linear (July 2026) — $384.00",
    body:
      "Receipt from Linear, Inc. Amount paid $384.00. Paid Jul 1, 2026. Workspace plan, 32 seats × $12.00. Download your invoice or view your billing history.",
    date: "8:31 AM",
  },
  {
    id: 5,
    name: "Marcus Delgado",
    title: "Offsite agenda — need your session by EOD",
    body:
      "Hey — locking the offsite agenda tonight. You're down for the 45-min architecture walkthrough on day 2. Can you send me a one-line description and any prep",
    date: "Jul 1",
  },
  {
    id: 6,
    name: "Vercel",
    title: "Deployment failed: acme-web (production)",
    body:
      "Your deployment acme-web-git-main failed to build. Error: Command \"pnpm build\" exited with 1. Check the build logs for details. This affects the production alias",
    date: "Jul 1",
  },
  {
    id: 7,
    name: "Linear",
    title: "Weekly digest: 14 issues completed, 6 added in Platform",
    body:
      "Your team shipped 14 issues last week. Cycle 23 is 68% complete with 3 days remaining. At-risk: ENG-1247 (blocked 4 days), ENG-1252 (no assignee).",
    date: "Jul 1",
  },
  {
    id: 8,
    name: "Priya Natarajan",
    title: "Figma updated — onboarding flow v3",
    body:
      "Third pass on the onboarding flow is up. Killed the carousel like we discussed, first-run is now a single checklist. Take a look before Thursday's review so we",
    date: "Jul 1",
  },
  {
    id: 9,
    name: "AWS Billing",
    title: "Your AWS bill for June 2026 is available — $2,847.19",
    body:
      "Your invoice for the billing period June 1 – June 30, 2026 is now available. Total: $2,847.19. Top services: EC2 $1,204.55, RDS $688.02, S3 $301.44.",
    date: "Jul 1",
  },
  {
    id: 10,
    name: "Datadog",
    title: "[Triggered] p95 latency > 800ms on api-gateway",
    body:
      "Monitor p95 latency api-gateway triggered at 06:14 UTC. Current value: 1,240ms over threshold 800ms for the last 10 minutes. Affected env: production.",
    date: "Jun 30",
  },
  {
    id: 11,
    name: "Jenny Park (Greenhouse)",
    title: "Interview confirmed: Staff Engineer candidate, Fri 11am",
    body:
      "You're confirmed for the systems design interview with Daniel Osei on Friday Jul 3, 11:00–12:00. Scorecard and resume are linked. Please submit feedback within",
    date: "Jun 30",
  },
  {
    id: 12,
    name: "Notion",
    title: "Alex mentioned you in \"Incident retro: 6/28 checkout outage\"",
    body:
      "Alex Rivera mentioned you: \"@you can you own the follow-up on connection pool limits? Marking you on action item 3.\" Open in Notion to reply.",
    date: "Jun 30",
  },
  {
    id: 13,
    name: "The Pragmatic Engineer",
    title: "The Pulse #147: What the Figma IPO filing reveals",
    body:
      "Welcome to The Pulse. In this issue: Figma's S-1 numbers in context, why mid-size startups are re-bundling infra, and notes on the July hiring market.",
    date: "Jun 30",
  },
  {
    id: 14,
    name: "Slack",
    title: "You have 3 mentions in #eng-platform",
    body:
      "While you were away: Marcus mentioned you in a thread about the webhook retry fix, and 2 more mentions in #eng-platform. Catch up in Slack.",
    date: "Jun 29",
  },
  {
    id: 15,
    name: "Sarah Kim",
    title: "Intro: Tomás from Meridian Ventures",
    body:
      "Connecting you two — Tomás is doing a deep dive on dev-tools infra and I mentioned the migration work your team did last quarter. Tomás, meet the person who",
    date: "Jun 29",
  },
  {
    id: 16,
    name: "United Airlines",
    title: "Your trip confirmation — SFO ⇄ AUS, Jul 14",
    body:
      "Confirmation #KX4R2N. San Francisco (SFO) to Austin (AUS), Tue Jul 14 departing 8:05 AM, seat 21C. Return Thu Jul 16 arriving 9:40 PM. Check in 24 hours before",
    date: "Jun 29",
  },
  {
    id: 17,
    name: "GitHub",
    title: "[acme/platform] Review requested on PR #479: Extract rate limiter into middleware",
    body:
      "Marcus Delgado requested your review on #479. \"Pulls the token-bucket logic out of the gateway handler so the cron service can reuse it. Mostly mechanical.\"",
    date: "Jun 28",
  },
  {
    id: 18,
    name: "Google Cloud",
    title: "Your project 'acme-staging' exceeded 80% of budget",
    body:
      "Budget alert: acme-staging has used $812.44 of your $1,000.00 monthly budget. At the current rate you will exceed the budget before the end of the period.",
    date: "Jun 28",
  },
  {
    id: 19,
    name: "Alex Rivera",
    title: "Retro doc + action items from the checkout outage",
    body:
      "Retro is written up. TL;DR: connection pool exhaustion under the flash-sale spike, masked by the retry storm. Five action items, three owned, two need owners —",
    date: "Jun 28",
  },
  {
    id: 20,
    name: "Figma",
    title: "Priya invited you to \"Mobile app — Q3 concepts\"",
    body:
      "Priya Natarajan invited you to edit the file Mobile app — Q3 concepts. Open in Figma to view the latest frames and leave feedback.",
    date: "Jun 27",
  },
  {
    id: 21,
    name: "Chase",
    title: "Your statement is ready — account ending 4417",
    body:
      "Your June statement for the account ending in 4417 is now available. Statement balance: $3,208.77. Payment due Jul 25. View your statement online.",
    date: "Jun 27",
  },
  {
    id: 22,
    name: "Lenny's Newsletter",
    title: "How the best PMs run launch reviews",
    body:
      "This week: a tactical guide to launch reviews — the pre-mortem template, who should be in the room, and the single question that kills weak launches early.",
    date: "Jun 26",
  },
  {
    id: 23,
    name: "Marcus Delgado",
    title: "Re: rate limiter PR — good catch, fixed",
    body:
      "You were right about the burst window math — off by a factor of the refill interval. Pushed a fix with a regression test. Should be green now, mind re-approving?",
    date: "Jun 26",
  },
  {
    id: 24,
    name: "Zoom",
    title: "Cloud recording ready: Eng All-Hands (Jun 25)",
    body:
      "Your cloud recording is ready. Eng All-Hands — Jun 25, 2026, 58 minutes. Topics: H2 priorities, platform team re-org, Q&A. View or share the recording.",
    date: "Jun 25",
  },
  {
    id: 25,
    name: "Anna Liu",
    title: "Dinner Thursday? New ramen place on Valencia",
    body:
      "It finally opened! The one we walked past in March. I'm thinking 7:30 Thursday — they don't take reservations but the line moves fast apparently. You in?",
    date: "Jun 25",
  },
  {
    id: 26,
    name: "npm",
    title: "Security advisory affecting 2 of your projects",
    body:
      "A high-severity advisory (GHSA-73xr) was published for fast-xml-parser < 4.4.1. Dependabot has opened pull requests in acme/platform and acme/cron-service.",
    date: "Jun 24",
  },
  {
    id: 27,
    name: "Google Calendar",
    title: "Updated invitation: 1:1 with Sarah — now Wed 3pm",
    body:
      "Sarah Kim updated the event 1:1 Sarah / you. Changed: time — now Wednesday 3:00 – 3:30pm weekly. Note: \"moving to avoid the design review conflict.\"",
    date: "Jun 24",
  },
  {
    id: 28,
    name: "Substack",
    title: "Money Stuff: The index fund that ate the market",
    body:
      "Matt Levine on what happens when passive isn't passive anymore, plus SEC comment letters, a crypto footnote, and the usual disclaimers about nothing being",
    date: "Jun 23",
  },
  {
    id: 29,
    name: "HR @ Acme",
    title: "Open enrollment closes Friday — action required",
    body:
      "Reminder: benefits open enrollment closes Friday Jun 26 at 5pm PT. If you take no action your current elections roll over, except FSA contributions which reset",
    date: "Jun 23",
  },
  {
    id: 30,
    name: "Jenny Park (Greenhouse)",
    title: "Scorecard reminder: feedback due for Daniel Osei",
    body:
      "Friendly reminder to submit your interview scorecard for Daniel Osei (Staff Engineer). Feedback is due within 24 hours of the interview to keep the loop on",
    date: "Jun 22",
  },
  {
    id: 31,
    name: "Delta Dental",
    title: "Appointment reminder: cleaning on Jul 8, 9:00 AM",
    body:
      "This is a reminder of your upcoming appointment with Dr. Feldman on Wednesday, Jul 8 at 9:00 AM. Reply C to confirm or call our office to reschedule.",
    date: "Jun 22",
  },
  {
    id: 32,
    name: "GitHub",
    title: "[acme/platform] Nightly build failed on main",
    body:
      "Workflow nightly-e2e failed on main. 2 of 214 tests failed: checkout_flow_spec (timeout), webhook_retry_spec (flaky, retried twice). View the run for logs.",
    date: "Jun 21",
  },
  {
    id: 33,
    name: "Airbnb",
    title: "Your reservation in Austin is confirmed",
    body:
      "You're going to Austin! Entire loft hosted by Camille, Jul 14 – 16. Check-in after 3:00 PM. Confirmation code HMKQ8Z. Your host will send check-in details before",
    date: "Jun 21",
  },
  {
    id: 34,
    name: "Anna Liu",
    title: "Photos from the weekend",
    body:
      "Finally pulled these off my camera — the ones from Point Reyes came out great, especially the lighthouse ones at golden hour. Shared album link inside.",
    date: "Jun 20",
  },
  {
    id: 35,
    name: "Product Hunt Daily",
    title: "The 10 best products of June",
    body:
      "Our monthly roundup: an open-source Retool alternative tops the list, plus an on-device transcription app and a surprisingly good CLI for managing feature flags.",
    date: "Jun 20",
  },
  {
    id: 36,
    name: "DoorDash",
    title: "Your order from Souvla is on the way",
    body:
      "Estimated arrival 12:40 PM. Your Dasher, Miguel, picked up your order: 1× Lamb salad, 1× Greek fries, 1× Frozen Greek yogurt. Track your order live.",
    date: "Jun 19",
  },
  {
    id: 37,
    name: "Alex Rivera",
    title: "Can you cover on-call Jul 4 weekend?",
    body:
      "I know it's a big ask — Maya's wedding is that weekend and I'm officiating. I'll take your Jul 18 rotation plus one floater. Traffic should be quiet with the",
    date: "Jun 19",
  },
  {
    id: 38,
    name: "LinkedIn",
    title: "You have 4 new invitations and a message from a recruiter",
    body:
      "Rachel T., Technical Sourcer at a stealth AI infrastructure startup: \"Your work on high-throughput webhook systems caught our eye — open to a quick chat this",
    date: "Jun 18",
  },
  {
    id: 39,
    name: "Google Domains",
    title: "Renewal notice: acmelabs.dev renews Jul 15",
    body:
      "Your domain acmelabs.dev will automatically renew on Jul 15, 2026 for $12.00. No action is needed. Manage auto-renew settings in your account.",
    date: "Jun 18",
  },
  {
    id: 40,
    name: "Sarah Kim",
    title: "Board deck — final numbers section for review",
    body:
      "Last pass before this goes out tomorrow morning. Can you sanity-check slides 14–17? Specifically the infra cost trend line — want to make sure the June",
    date: "Jun 17",
  },
  {
    id: 41,
    name: "Strava",
    title: "Your June recap: 87.4 miles, 12 activities",
    body:
      "Strong month! You ran 87.4 miles across 12 activities, up 18% from May. Longest run: 13.2 miles on Jun 14. You earned 3 new achievements.",
    date: "Jun 17",
  },
  {
    id: 42,
    name: "Cloudflare",
    title: "Unusual traffic spike on api.acmelabs.dev",
    body:
      "We detected a traffic anomaly: requests to api.acmelabs.dev increased 640% between 02:00–02:20 UTC, mitigated by rate limiting rules. No action required.",
    date: "Jun 16",
  },
  {
    id: 43,
    name: "Marcus Delgado",
    title: "Postgres 17 upgrade plan — draft",
    body:
      "Wrote up the staging-first plan we talked about: logical replication to a 17 replica, cutover window Sunday 6am, rollback is DNS flip back to the 15 primary.",
    date: "Jun 16",
  },
  {
    id: 44,
    name: "Ticketmaster",
    title: "Your tickets: LCD Soundsystem at the Greek Theatre",
    body:
      "You're going! LCD Soundsystem, Sat Aug 22, 8:00 PM, Greek Theatre Berkeley, Sec B Row 12 Seats 107–108. Tickets are in your account and transfer is enabled.",
    date: "Jun 15",
  },
  {
    id: 45,
    name: "Priya Natarajan",
    title: "User interviews — 3 clips you should watch",
    body:
      "Cut down Tuesday's sessions to the parts that matter: two users completely missed the integrations tab, one called the settings page \"a filing cabinet from",
    date: "Jun 15",
  },
  {
    id: 46,
    name: "1Password",
    title: "New sign-in to your account from Mac (San Francisco)",
    body:
      "We noticed a new sign-in to your 1Password account from a Mac in San Francisco, CA at 8:12 AM PDT. If this was you, no action is needed.",
    date: "Jun 14",
  },
  {
    id: 47,
    name: "The Information",
    title: "Exclusive: Inside the scramble to secure GPU capacity for 2027",
    body:
      "Cloud providers are quietly rewriting capacity contracts as demand forecasts for 2027 blow past supply. Plus: a major fintech explores a sale, and our weekend",
    date: "Jun 13",
  },
  {
    id: 48,
    name: "REI Co-op",
    title: "Your order has shipped — arriving Jun 17",
    body:
      "Good news! Your order #R2044817 has shipped: Trail-running vest (M), 2× energy gel variety pack. Track your package. Estimated delivery Wednesday Jun 17.",
    date: "Jun 13",
  },
  {
    id: 49,
    name: "Google",
    title: "Security alert: new sign-in on Pixel 9",
    body:
      "New sign-in to your Google Account on Pixel 9. If this was you, you don't need to do anything. If not, we'll help you secure your account.",
    date: "Jun 12",
  },
  {
    id: 50,
    name: "Kickstarter",
    title: "Project update #12: Split ergonomic keyboard — shipping begins!",
    body:
      "We're finally in production! First 500 units ship this week, backers 501–2,000 in early August. Full timeline and a factory video inside this update.",
    date: "Jun 12",
  },
  {
    id: 51,
    name: "Waymo",
    title: "Your trip receipt — $18.40",
    body:
      "Thanks for riding! Jun 11, 6:22 PM, Mission St to Hayes Valley, 2.8 miles, 14 minutes. Total charged: $18.40 to card ending 4417. Rate your trip.",
    date: "Jun 11",
  },
];

export default NAME_DATA;
