/**
 * W2 Kit gallery — renders every Kit component under both demo-host themes
 * (Maple + Cadence). Browser-verification surface; screenshots are committed to
 * docs/verification/w2-kit/. Not shipped in the package.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { VendoTheme } from "@vendoai/core";
import { themeCssVariables } from "../src/theme.js";
import {
  Accordion,
  Badge,
  BarChart,
  Button,
  Callout,
  CardList,
  Checkbox,
  DataTable,
  DatePicker,
  DateTime,
  Disclaimer,
  Divider,
  DonutChart,
  EnumBadge,
  Form,
  Grid,
  Input,
  LineChart,
  Money,
  Num,
  Percent,
  Progress,
  Row,
  Select,
  Sparkline,
  Stack,
  Stat,
  Surface,
  Tabs,
  Text,
  Textarea,
} from "../src/kit/index.js";

const MAPLE: VendoTheme = {
  colors: { background: "#FBFBFA", surface: "#FFFFFF", text: "#111111", muted: "#908C85", accent: "#111111", accentText: "#FFFFFF", danger: "#B42318", border: "#E2E1DE" },
  typography: { fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", baseSize: "15px" },
  radius: { small: "6px", medium: "14px", large: "14px" },
  density: "comfortable",
  motion: "full",
};

const CADENCE: VendoTheme = {
  colors: { background: "#fbfbfa", surface: "#ffffff", text: "#111111", muted: "#46443f", accent: "#3B5BDB", accentText: "#FFFFFF", danger: "#B0473A", border: "#ECEBE8" },
  typography: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", baseSize: "15px" },
  radius: { small: "6px", medium: "12px", large: "12px" },
  density: "comfortable",
  motion: "full",
};

const invoices = [
  { id: 1, client: { name: "Hartwell & Co" }, amountCents: 250000, dueDate: "2026-03-14", status: "overdue" },
  { id: 2, client: { name: "Acme Labs" }, amountCents: 90000, dueDate: "2026-04-02", status: "paid" },
  { id: 3, client: { name: "Borealis" }, amountCents: 175050, dueDate: "2026-02-20", status: "overdue" },
  { id: 4, client: { name: "Northwind" }, amountCents: 42000, dueDate: "2026-05-01", status: "pending" },
];

const revenue = [
  { month: "Jan", amountCents: 820000, refundsCents: 40000 },
  { month: "Feb", amountCents: 910000, refundsCents: 30000 },
  { month: "Mar", amountCents: 760000, refundsCents: 55000 },
  { month: "Apr", amountCents: 1120000, refundsCents: 20000 },
  { month: "May", amountCents: 1340000, refundsCents: 35000 },
];

const spend = [
  { category: "Payroll", amountCents: 4200000 },
  { category: "Cloud", amountCents: 900000 },
  { category: "Travel", amountCents: 350000 },
  { category: "Tools", amountCents: 220000 },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Text text={title} variant="heading" />
      {children}
    </div>
  );
}

function Showcase() {
  return (
    <Stack gap={20}>
      <Section title="Values (semantic — formatted for you)">
        <Row gap={16}>
          <span><Text text="Money " variant="caption" /><Money cents={1234056} /></span>
          <span><Text text="Date " variant="caption" /><DateTime value="2026-03-14" mode="date" /></span>
          <span><Text text="Percent " variant="caption" /><Percent value={0.4213} fractionDigits={1} /></span>
          <span><Text text="Num " variant="caption" /><Num value={1500000} notation="compact" /></span>
          <EnumBadge value="past_due" tones={{ past_due: "danger" }} />
          <EnumBadge value="paid" tones={{ paid: "success" }} />
          <span><Text text="Invalid → " variant="caption" /><Money cents={Number.NaN} /></span>
        </Row>
      </Section>

      <Section title="DataTable — sort · filter · search · paginate · dot-path · per-column format">
        <DataTable
          rows={invoices}
          sortBy="dueDate asc"
          searchable
          filterableBy={["status"]}
          columns={[
            { key: "client.name", label: "Client" },
            { key: "amountCents", label: "Amount", format: "money", align: "end" },
            { key: "dueDate", label: "Due", format: "date" },
            { key: "status", label: "Status" },
          ]}
          emptyState="No overdue invoices"
        />
      </Section>

      <Grid columns={2} gap={16}>
        <Section title="Stat">
          <Row gap={12}>
            <Stat label="Total overdue" value={425050} format="money" trend="+12% MoM" tone="danger" />
            <Stat label="Collected" value={90000} format="money" trend="on track" tone="accent" />
          </Row>
        </Section>
        <Section title="Badges">
          <Row gap={8}>
            <Badge label="Beta" tone="accent" />
            <Badge label="Live" tone="success" />
            <Badge label="Deprecated" tone="warning" />
            <Badge label="Error" tone="danger" />
          </Row>
        </Section>
      </Grid>

      <Section title="CardList">
        <CardList
          items={invoices}
          titleField="client.name"
          badgeField="status"
          columns={4}
          fields={[
            { key: "amountCents", label: "Amount", format: "money" },
            { key: "dueDate", label: "Due", format: "date" },
          ]}
        />
      </Section>

      <Grid columns={2} gap={16}>
        <Surface title="LineChart">
          <LineChart data={revenue} xKey="month" series={[{ key: "amountCents", label: "Revenue" }, { key: "refundsCents", label: "Refunds" }]} format="money" height={200} />
        </Surface>
        <Surface title="BarChart (horizontal)">
          <BarChart data={spend} xKey="category" series={["amountCents"]} format="money" horizontal height={200} />
        </Surface>
        <Surface title="DonutChart">
          <DonutChart data={spend} categoryKey="category" valueKey="amountCents" format="money" height={200} />
        </Surface>
        <Surface title="Sparkline + Progress">
          <Stack gap={14}>
            <Sparkline data={[3, 5, 4, 8, 7, 11, 9, 14, 13, 18]} height={44} />
            <Progress value={0.68} label="Savings goal" showValue />
            <Progress value={30} max={60} label="Onboarding" showValue tone="success" />
            <div><Text text="Invalid chart → designed empty state:" variant="caption" /><LineChart data={[]} xKey="x" series={["v"]} height={80} emptyState="No trend yet" /></div>
          </Stack>
        </Surface>
      </Grid>

      <Grid columns={2} gap={16}>
        <Surface title="Forms">
          <Form onSubmit={(e) => e.preventDefault()} submitLabel="Add client">
            <Input label="Client name" placeholder="Hartwell & Co" />
            <Select label="Owner" options={[{ id: "u1", name: "Dana" }, { id: "u2", name: "Ravi" }]} labelField="name" valueField="id" placeholder="Choose…" />
            <DatePicker label="Due date" value="2026-03-14" />
            <Textarea label="Note" rows={2} placeholder="Optional note" />
            <Checkbox label="Send a reminder now" />
          </Form>
        </Surface>
        <Stack gap={12}>
          <Section title="Buttons (action-gated)">
            <Row gap={8}>
              <Button label="Remind all" />
              <Button label="Export" variant="secondary" />
              <Button label="Delete" variant="danger" />
            </Row>
          </Section>
          <Section title="Callout + Disclaimer">
            <Callout tone="warning" title="Heads up">Three invoices are overdue.</Callout>
            <Disclaimer reason="No tool exposes payroll data, so this can't be shown." />
          </Section>
        </Stack>
      </Grid>

      <Grid columns={2} gap={16}>
        <Surface title="Tabs (self-managing)">
          <Tabs
            tabs={[
              { label: "Overview", content: <Text text="Overview panel content." /> },
              { label: "Detail", content: <Text text="Detail panel content." /> },
              { label: "History", content: <Text text="History panel content." /> },
            ]}
          />
        </Surface>
        <Surface title="Accordion (self-managing)">
          <Accordion
            defaultOpen={[0]}
            items={[
              { label: "Payment terms", content: <Text text="Net 30 from invoice date." /> },
              { label: "Late fees", content: <Text text="1.5% per month on overdue balances." /> },
            ]}
          />
        </Surface>
      </Grid>
      <Divider />
      <Text text="Layout primitives (Stack, Row, Grid, Surface, Divider) frame this whole page." variant="caption" />
    </Stack>
  );
}

function ThemedPanel({ name, theme }: { name: string; theme: VendoTheme }) {
  const vars = themeCssVariables(theme) as React.CSSProperties;
  return (
    <div
      data-theme={name}
      style={{
        ...vars,
        background: "var(--vendo-color-background)",
        color: "var(--vendo-color-text)",
        fontFamily: "var(--vendo-font-family)",
        padding: 28,
        minHeight: "100vh",
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <h1 style={{ fontFamily: "var(--vendo-font-family)", fontSize: 22, marginTop: 0, letterSpacing: "-0.02em" }}>
          Vendo Kit — {name} theme
        </h1>
        <Showcase />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div>
      <ThemedPanel name="Maple" theme={MAPLE} />
      <ThemedPanel name="Cadence" theme={CADENCE} />
    </div>
  </StrictMode>,
);
