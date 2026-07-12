export type InvoiceStatus = "draft" | "open" | "paid";

export interface Customer {
  id: string;
  name: string;
  email: string;
}

export interface Invoice {
  id: string;
  customerId: string;
  amountCents: number;
  currency: "USD";
  status: InvoiceStatus;
  memo: string;
  createdAt: string;
  sentAt?: string;
}

export interface InvoiceFilter {
  status?: string;
  customerId?: string;
}

export interface CreateInvoiceInput {
  customerId: string;
  amountCents: number;
  currency?: "USD";
  memo?: string;
}

export interface UpdateInvoicePatch {
  memo?: string;
  amountCents?: number;
  status?: InvoiceStatus;
}

const CREATED_AT = "2026-07-01T00:00:00.000Z";
const SENT_AT = "2026-07-01T12:00:00.000Z";

const seedCustomers: Customer[] = [
  { id: "cus_ada", name: "Ada Lovelace", email: "ada@example.test" },
  { id: "cus_bob", name: "Bob Noyce", email: "bob@example.test" },
  { id: "cus_cle", name: "Cleo Chen", email: "cleo@example.test" },
];

const seedInvoices: Invoice[] = [
  { id: "inv_0001", customerId: "cus_ada", amountCents: 12500, currency: "USD", status: "paid", memo: "Analytical engine consultation", createdAt: CREATED_AT },
  { id: "inv_0002", customerId: "cus_ada", amountCents: 4800, currency: "USD", status: "open", memo: "Algorithm review", createdAt: CREATED_AT, sentAt: SENT_AT },
  { id: "inv_0003", customerId: "cus_ada", amountCents: 3200, currency: "USD", status: "draft", memo: "Technical notes", createdAt: CREATED_AT },
  { id: "inv_0004", customerId: "cus_bob", amountCents: 25000, currency: "USD", status: "paid", memo: "Semiconductor workshop", createdAt: CREATED_AT },
  { id: "inv_0005", customerId: "cus_bob", amountCents: 9900, currency: "USD", status: "open", memo: "Prototype review", createdAt: CREATED_AT, sentAt: SENT_AT },
  { id: "inv_0006", customerId: "cus_bob", amountCents: 7500, currency: "USD", status: "draft", memo: "Design session", createdAt: CREATED_AT },
  { id: "inv_0007", customerId: "cus_cle", amountCents: 18000, currency: "USD", status: "paid", memo: "Operations audit", createdAt: CREATED_AT },
  { id: "inv_0008", customerId: "cus_cle", amountCents: 6100, currency: "USD", status: "draft", memo: "Planning session", createdAt: CREATED_AT },
];

const customers = new Map<string, Customer>();
const invoices = new Map<string, Invoice>();
let nextInvoiceNumber = 9001;

function copyCustomer(customer: Customer): Customer {
  return { ...customer };
}

function copyInvoice(invoice: Invoice): Invoice {
  return { ...invoice };
}

export function resetDb(): void {
  customers.clear();
  invoices.clear();

  for (const customer of seedCustomers) {
    customers.set(customer.id, copyCustomer(customer));
  }
  for (const invoice of seedInvoices) {
    invoices.set(invoice.id, copyInvoice(invoice));
  }

  nextInvoiceNumber = 9001;
}

export function listInvoices(filter: InvoiceFilter = {}): Invoice[] {
  return Array.from(invoices.values())
    .filter((invoice) => !filter.status || invoice.status === filter.status)
    .filter((invoice) => !filter.customerId || invoice.customerId === filter.customerId)
    .map(copyInvoice);
}

export function getInvoice(id: string): Invoice | undefined {
  const invoice = invoices.get(id);
  return invoice ? copyInvoice(invoice) : undefined;
}

export function createInvoice(input: CreateInvoiceInput): Invoice {
  const id = `inv_${nextInvoiceNumber}`;
  nextInvoiceNumber += 1;

  const invoice: Invoice = {
    id,
    customerId: input.customerId,
    amountCents: input.amountCents,
    currency: input.currency ?? "USD",
    status: "draft",
    memo: input.memo ?? "",
    createdAt: CREATED_AT,
  };
  invoices.set(id, invoice);
  return copyInvoice(invoice);
}

export function updateInvoice(id: string, patch: UpdateInvoicePatch): Invoice | undefined {
  const current = invoices.get(id);
  if (!current) {
    return undefined;
  }

  const invoice = { ...current };
  if (patch.memo !== undefined) {
    invoice.memo = patch.memo;
  }
  if (patch.amountCents !== undefined) {
    invoice.amountCents = patch.amountCents;
  }
  if (patch.status !== undefined) {
    invoice.status = patch.status;
  }
  invoices.set(id, invoice);
  return copyInvoice(invoice);
}

export function deleteInvoice(id: string): boolean {
  return invoices.delete(id);
}

export function sendInvoice(id: string): Invoice | undefined {
  const current = invoices.get(id);
  if (!current) {
    return undefined;
  }

  const invoice: Invoice = { ...current, status: "open", sentAt: SENT_AT };
  invoices.set(id, invoice);
  return copyInvoice(invoice);
}

export function listCustomers(): Customer[] {
  return Array.from(customers.values()).map(copyCustomer);
}

resetDb();
