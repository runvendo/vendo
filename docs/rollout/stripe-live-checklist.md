# Stripe Go-Live Checklist

The Stripe account is **already live**; the product/meter catalog exists in **test mode**. This list is only what stands between test mode and charging real cards. Items marked **[Yousef]** require account-owner access or a business decision — no one else can do them.

## Account-level (one-time)

- [ ] **[Yousef] Verify Stripe Tax registration/config** — confirm tax registrations for the jurisdictions we sell into, Tax enabled on subscriptions and metered invoices, correct product tax codes (SaaS).
- [ ] **[Yousef] Decide the statement descriptor** — what appears on customers' card statements (e.g. `VENDO.RUN`). Business decision + account setting.
- [ ] **[Yousef] Confirm invoice footer and business details** — legal entity name, address, support email on invoices; any required footer text (tax ID, terms link).

## Mirror the final test-mode catalog to live mode

Recreate exactly these objects in live mode, matched to the final test-mode versions (lookup keys must be identical so code needs no environment-specific IDs):

- [ ] **3 plan products, each with monthly + annual prices** (annual at ~2 months free, per spec §6): Pro $49/mo, Teams $499/mo, plus the third plan product as it exists in test mode.
- [ ] **6 uniform metered prices with lookup keys** — one per meter, same rate on Pro and Teams (spec §3): managed AI tokens (passthrough+15%), sandbox minutes ($0.01/min), storage ($0.25/GB-mo), knowledge ($0.60/GB-mo), automation runs ($3/1k), active connections (~$0.30/conn-mo). Graduated volume tiers per §6 where configured in test mode.
- [ ] **Meters:** `knowledge_gb`, `active_connections`, and the **AI netting** meter (dollar-denominated managed-AI usage with plan credits netted per §4). Verify the other meters' event names match what the services already emit.
- [ ] **Webhook endpoint config** — register the live-mode endpoint URL, subscribe to the same event set as test mode, store the live signing secret in the production secret store (not `.env` files).

## Sanity pass before first real charge

- [ ] One end-to-end live test: subscribe a real card (own card) to Pro, push metered usage events, confirm the invoice shows plan fee + per-meter lines with credits netted, then refund/cancel.
- [ ] Confirm billing thresholds (mid-cycle settlement at max($100, 1× plan price), spec §6) and dunning settings (7–14 day grace, §6) are set in live mode, not just test.

Everything not listed here (products beyond these, wallets, credit packs, per-block SKUs) is deliberately out of scope per the one-SKU design.
