// EXAMPLE ENTITY — everything under src/server is the fake-host-API pattern
// the demo creator replaces with the prospect's own domain (invoices, tickets,
// shipments, …). One deliberately generic entity ("items") demonstrates the
// full loop: deterministic seed → in-memory store → typed read/write modules →
// API routes declared in openapi.json so `vendo sync .` exposes them as
// agent-callable tools.
export type ItemStatus = "active" | "archived"

export interface Item {
  id: string
  name: string
  status: ItemStatus
  amount: number             // cents
  updatedAt: string          // ISO 8601
}
