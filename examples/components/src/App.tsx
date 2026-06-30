import { createStubAgent } from "@flowlet/core";
import { FlowletProvider, StubRenderer } from "@flowlet/react";
import {
  prewiredComponents,
  prewiredImpls,
  FlowletThemeProvider,
  defaultBrand,
} from "@flowlet/components";

const agent = createStubAgent();

const samples = [
  {
    id: "card",
    kind: "component" as const,
    source: "prewired" as const,
    name: "Card",
    props: {
      title: "Checking Account",
      subtitle: "****1234",
      iconName: "wallet",
      body: "Your balance is $4,210.88. No pending transactions.",
      tags: ["active", "verified"],
    },
  },
  {
    id: "table",
    kind: "component" as const,
    source: "prewired" as const,
    name: "Table",
    props: {
      caption: "Recent Transactions",
      columns: [
        { key: "date", label: "Date" },
        { key: "description", label: "Description" },
        { key: "amount", label: "Amount" },
        { key: "status", label: "Status" },
      ],
      rows: [
        { date: "2026-06-28", description: "Grocery Store", amount: "-$52.40", status: "Cleared" },
        { date: "2026-06-27", description: "Direct Deposit", amount: "+$2,400.00", status: "Cleared" },
        { date: "2026-06-26", description: "Netflix", amount: "-$15.99", status: "Cleared" },
        { date: "2026-06-25", description: "Coffee Shop", amount: "-$6.75", status: "Pending" },
      ],
    },
  },
  {
    id: "chart",
    kind: "component" as const,
    source: "prewired" as const,
    name: "Chart",
    props: {
      kind: "bar",
      title: "Monthly Spending",
      categoryKey: "month",
      series: ["spending", "income"],
      data: [
        { month: "Apr", spending: 1850, income: 2400 },
        { month: "May", spending: 2100, income: 2400 },
        { month: "Jun", spending: 1640, income: 2400 },
      ],
    },
  },
  {
    id: "form",
    kind: "component" as const,
    source: "prewired" as const,
    name: "Form",
    props: {
      title: "Transfer Funds",
      submitLabel: "Send Transfer",
      fields: [
        { type: "text", name: "recipient", label: "Recipient Name", required: true, placeholder: "Full name" },
        { type: "number", name: "amount", label: "Amount ($)", required: true, placeholder: "0.00" },
        {
          type: "select",
          name: "account",
          label: "From Account",
          options: [
            { value: "checking", label: "Checking ****1234" },
            { value: "savings", label: "Savings ****5678" },
          ],
        },
        { type: "date", name: "sendDate", label: "Send Date" },
        { type: "textarea", name: "memo", label: "Memo", placeholder: "Optional note" },
      ],
    },
  },
  {
    id: "accordion",
    kind: "component" as const,
    source: "prewired" as const,
    name: "Accordion",
    props: {
      items: [
        { title: "What is Flowlet?", content: "Flowlet is an AI-native fintech platform that builds UI on the fly." },
        { title: "How secure is my data?", content: "All data is encrypted in transit and at rest using AES-256." },
        { title: "Can I export my transactions?", content: "Yes, you can export to CSV or PDF from the Reports section." },
      ],
    },
  },
  {
    id: "carousel",
    kind: "component" as const,
    source: "prewired" as const,
    name: "Carousel",
    props: {
      items: [
        {
          title: "Earn 2% Cashback",
          body: "Use your Flowlet card on everyday purchases and earn cashback automatically.",
          imageUrl: "https://picsum.photos/seed/promo1/400/200",
        },
        {
          title: "Zero-Fee International",
          body: "Spend abroad with no foreign transaction fees and real exchange rates.",
          imageUrl: "https://picsum.photos/seed/promo2/400/200",
        },
        {
          title: "Instant Notifications",
          body: "Get alerted the moment a transaction hits your account.",
          imageUrl: "https://picsum.photos/seed/promo3/400/200",
        },
      ],
    },
  },
  {
    id: "callout",
    kind: "component" as const,
    source: "prewired" as const,
    name: "Callout",
    props: {
      variant: "warning",
      title: "Unusual Activity Detected",
      text: "We noticed a login attempt from a new device in Berlin. Please verify it was you.",
    },
  },
  {
    id: "tags",
    kind: "component" as const,
    source: "prewired" as const,
    name: "Tags",
    props: {
      items: [
        { text: "Active", variant: "success" },
        { text: "KYC Verified", variant: "info" },
        { text: "Premium", variant: "default" },
        { text: "Auto-pay On", variant: "default" },
      ],
    },
  },
  {
    id: "steps",
    kind: "component" as const,
    source: "prewired" as const,
    name: "Steps",
    props: {
      steps: [
        { title: "Create Account", text: "Sign up with your email and create a secure password." },
        { title: "Verify Identity", text: "Upload a government-issued ID to complete KYC." },
        { title: "Link Bank", text: "Connect your existing bank account via Plaid." },
        { title: "Start Banking", text: "Your Flowlet account is ready to use." },
      ],
    },
  },
  {
    id: "list",
    kind: "component" as const,
    source: "prewired" as const,
    name: "List",
    props: {
      items: [
        { title: "Checking ****1234", subtitle: "$4,210.88 available" },
        { title: "Savings ****5678", subtitle: "$12,450.00 available" },
        { title: "Credit Card ****9012", subtitle: "$320.00 balance due" },
        { title: "Investment ****3456", subtitle: "$8,902.33 portfolio value" },
      ],
    },
  },
  {
    id: "image",
    kind: "component" as const,
    source: "prewired" as const,
    name: "Image",
    props: {
      src: "https://picsum.photos/seed/flowlet/760/240",
      alt: "Flowlet dashboard preview",
      caption: "The Flowlet AI banking dashboard adapts to your financial context.",
    },
  },
  {
    id: "imageGallery",
    kind: "component" as const,
    source: "prewired" as const,
    name: "ImageGallery",
    props: {
      images: [
        { src: "https://picsum.photos/seed/g1/200/150", alt: "Dashboard view" },
        { src: "https://picsum.photos/seed/g2/200/150", alt: "Transactions" },
        { src: "https://picsum.photos/seed/g3/200/150", alt: "Analytics" },
        { src: "https://picsum.photos/seed/g4/200/150", alt: "Cards" },
        { src: "https://picsum.photos/seed/g5/200/150", alt: "Transfers" },
        { src: "https://picsum.photos/seed/g6/200/150", alt: "Settings" },
      ],
    },
  },
  {
    id: "markdown",
    kind: "component" as const,
    source: "prewired" as const,
    name: "Markdown",
    props: {
      content: `## Your Financial Summary

**Net worth** this month is up **8.3%** compared to last month.

### Highlights
- Savings rate: **22%** — above your 20% goal
- Largest expense: *Dining* at $340
- Upcoming bill: **Rent** on July 1 — $1,850

> Tip: Moving $200 more per month to your HYSA could earn an extra $96/year at current rates.`,
    },
  },
  {
    id: "codeBlock",
    kind: "component" as const,
    source: "prewired" as const,
    name: "CodeBlock",
    props: {
      language: "typescript",
      code: `import { createStubAgent } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";

const agent = createStubAgent();

export function App() {
  return (
    <FlowletProvider agent={agent} components={[]}>
      {/* your UI */}
    </FlowletProvider>
  );
}`,
    },
  },
  {
    id: "tabs",
    kind: "component" as const,
    source: "prewired" as const,
    name: "Tabs",
    props: {
      tabs: [
        { label: "Overview", content: "Your account is in good standing. Balance: $4,210.88." },
        { label: "Transactions", content: "Last 30 days: 24 transactions totalling $1,640.15 in outflows." },
        { label: "Statements", content: "June 2026 statement is ready. Download PDF from the Documents section." },
      ],
    },
  },
];

export function App() {
  return (
    <FlowletProvider agent={agent} components={prewiredComponents}>
      <FlowletThemeProvider brand={defaultBrand}>
        <main style={{ display: "grid", gap: 24, maxWidth: 760, margin: "40px auto", padding: 16 }}>
          <h1 style={{ fontFamily: "system-ui", marginBottom: 8 }}>Flowlet pre-wired components</h1>
          {samples.map((node) => (
            <section key={node.id}>
              <h2 style={{ fontFamily: "system-ui", fontSize: 13, opacity: 0.55, fontWeight: 500, marginBottom: 8 }}>
                {node.name}
              </h2>
              <StubRenderer node={node} impls={prewiredImpls as never} />
            </section>
          ))}
        </main>
      </FlowletThemeProvider>
    </FlowletProvider>
  );
}
