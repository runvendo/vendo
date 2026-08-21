import { mulberry32, pick, int } from "./prng"
import type {
  Address, Customer, Order, OrderLine, Product, Refund, Shipment, ShipmentEvent,
  StaffUser, StockAdjustment, Channel, OrderStatus,
} from "./types"

export interface SeedData {
  staff: StaffUser[]
  customers: Customer[]
  addresses: Address[]
  products: Product[]
  orders: Order[]
  shipments: Shipment[]
  refunds: Refund[]
  adjustments: StockAdjustment[]
  /** The duplicate-charge pair the demo story hangs off: [delivered, unfulfilled]. */
  story: { deliveredOrderNumber: string; duplicateOrderNumber: string; customerId: string }
}

/** Ninety days of order history. */
const HISTORY_DAYS = 90

function iso(d: Date) { return d.toISOString() }

function daysAgo(anchor: Date, n: number, h = 12, m = 0) {
  const d = new Date(anchor)
  d.setDate(d.getDate() - n)
  d.setHours(h, m, 0, 0)
  return d
}

function hoursAfter(base: Date, h: number) {
  const d = new Date(base)
  d.setHours(d.getHours() + h)
  return d
}

// ---------------------------------------------------------------- catalogue

const CATALOGUE: Omit<Product, "id" | "stockOnHand" | "stockReserved">[] = [
  { sku: "CRT-ESP-01", title: "Aurora Espresso Machine", description: "Dual-boiler espresso machine with a 58mm portafilter.", priceCents: 44900, category: "kitchen", reorderPoint: 6 },
  { sku: "CRT-GRD-02", title: "Aurora Burr Grinder", description: "Flat-burr grinder, 40 steps of adjustment.", priceCents: 18900, category: "kitchen", reorderPoint: 10 },
  { sku: "CRT-KTL-03", title: "Gooseneck Kettle", description: "Variable-temperature kettle with a one-degree readout.", priceCents: 8900, category: "kitchen", reorderPoint: 15 },
  { sku: "CRT-MUG-04", title: "Stoneware Mug, Set of 4", description: "Reactive-glaze stoneware. Dishwasher safe.", priceCents: 4800, category: "tabletop", reorderPoint: 24 },
  { sku: "CRT-SCL-05", title: "Precision Scale", description: "0.1g resolution with a built-in brew timer.", priceCents: 6500, category: "kitchen", reorderPoint: 12 },
  { sku: "CRT-CHR-06", title: "Walnut Counter Stool", description: "Solid walnut, 26in seat height.", priceCents: 29900, category: "furniture", reorderPoint: 4 },
  { sku: "CRT-LMP-07", title: "Ceramic Table Lamp", description: "Hand-thrown base with a linen shade.", priceCents: 15900, category: "lighting", reorderPoint: 8 },
  { sku: "CRT-APR-08", title: "Canvas Work Apron", description: "Waxed canvas with leather straps.", priceCents: 7400, category: "textiles", reorderPoint: 20 },
  { sku: "CRT-BRD-09", title: "End-Grain Cutting Board", description: "Hard maple, 18x12in.", priceCents: 12900, category: "kitchen", reorderPoint: 10 },
  { sku: "CRT-TWL-10", title: "Linen Tea Towels, Pair", description: "Stonewashed European flax.", priceCents: 3200, category: "textiles", reorderPoint: 30 },
]

const FIRST = ["Dana", "Priya", "Marcus", "Elena", "Tobias", "Naomi", "Idris", "Clara", "Wren", "Hugo", "Simone", "Otis"]
const LAST = ["Whitfield", "Raman", "Oyelaran", "Sokolov", "Lindqvist", "Bennett", "Farah", "Nakamura", "Delacroix", "Mbeki", "Vasquez", "Halloran"]
const CITIES: [string, string, string][] = [
  ["Portland", "OR", "97209"], ["Austin", "TX", "78702"], ["Providence", "RI", "02906"],
  ["Boulder", "CO", "80302"], ["Savannah", "GA", "31401"], ["Missoula", "MT", "59801"],
  ["Ann Arbor", "MI", "48104"], ["Burlington", "VT", "05401"],
]
const STREETS = ["Alder St", "Mercer Ave", "Quarry Ln", "Fielding Rd", "Bishop Way", "Larkspur Ct"]
const CARRIERS = ["UPS", "USPS", "FedEx"]
const CHANNELS: Channel[] = ["web", "web", "web", "mobile", "mobile", "phone", "marketplace"]

// ------------------------------------------------------------------- people

/**
 * Two seeded staff, mirroring Maple's yousef/mia split: one admin, one
 * ordinary agent. Per-user isolation is demonstrable because refunds record
 * who issued them.
 */
function buildStaff(): StaffUser[] {
  return [
    { id: "stf_1", subject: "crate|admin", email: "yousef@crate.com", display: "Yousef Helal", role: "admin" },
    { id: "stf_2", subject: "crate|agent", email: "mia@crate.com", display: "Mia Alvarez", role: "agent" },
  ]
}

// -------------------------------------------------------------------- build

export function buildSeed(anchor: Date): SeedData {
  const rand = mulberry32(0x0c2a7e)

  const staff = buildStaff()

  const products: Product[] = CATALOGUE.map((p, i) => ({
    ...p,
    id: `prd_${i + 1}`,
    stockOnHand: int(rand, 0, 60),
    stockReserved: int(rand, 0, 4),
  }))

  // One product is deliberately below its reorder point so the low-stock view
  // and any "what should I reorder?" question have a real answer.
  products[0].stockOnHand = 3
  products[0].stockReserved = 2

  const customers: Customer[] = []
  const addresses: Address[] = []

  for (let i = 0; i < 12; i++) {
    const id = `cus_${i + 1}`
    const name = `${FIRST[i]} ${LAST[i]}`
    const [city, region, postalCode] = CITIES[i % CITIES.length]
    const addrId = `adr_${i + 1}`

    addresses.push({
      id: addrId,
      customerId: id,
      line1: `${int(rand, 100, 4800)} ${pick(rand, STREETS)}`,
      line2: rand() > 0.75 ? `Apt ${int(rand, 1, 40)}` : undefined,
      city, region, postalCode,
      country: "US",
    })

    customers.push({
      id,
      name,
      email: `${FIRST[i].toLowerCase()}@example.com`,
      phone: rand() > 0.5 ? `+1 555 0${int(rand, 100, 199)}` : undefined,
      createdAt: iso(daysAgo(anchor, int(rand, 120, 900))),
      defaultAddressId: addrId,
      lifetimeValueCents: 0,   // recomputed below from real orders
      orderCount: 0,
    })
  }

  const orders: Order[] = []
  const shipments: Shipment[] = []
  const refunds: Refund[] = []
  const adjustments: StockAdjustment[] = []

  let orderSeq = 1000

  function makeOrder(opts: {
    customer: Customer
    placedAt: Date
    status: OrderStatus
    items: { product: Product; quantity: number }[]
    channel?: Channel
    notes?: string
  }): Order {
    const seq = ++orderSeq
    const number = `CR-${seq}`
    const id = `ord_${seq}`

    const lines: OrderLine[] = opts.items.map((it, i) => ({
      id: `lin_${seq}_${i + 1}`,
      orderId: id,
      productId: it.product.id,
      sku: it.product.sku,
      title: it.product.title,
      quantity: it.quantity,
      unitPriceCents: it.product.priceCents,
      lineTotalCents: it.product.priceCents * it.quantity,
    }))

    const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0)
    const shippingCents = subtotalCents > 20000 ? 0 : 995
    const taxCents = Math.round(subtotalCents * 0.0725)

    const order: Order = {
      id,
      number,
      customerId: opts.customer.id,
      status: opts.status,
      placedAt: iso(opts.placedAt),
      currency: "USD",
      subtotalCents,
      shippingCents,
      taxCents,
      totalCents: subtotalCents + shippingCents + taxCents,
      shippingAddressId: opts.customer.defaultAddressId,
      paymentRef: `ch_${Math.floor(rand() * 1e12).toString(36)}`,
      channel: opts.channel ?? pick(rand, CHANNELS),
      lines,
      notes: opts.notes,
    }
    orders.push(order)
    return order
  }

  function makeShipment(order: Order, placedAt: Date, status: Shipment["status"]) {
    const shippedAt = hoursAfter(placedAt, int(rand, 18, 60))
    const events: ShipmentEvent[] = [
      { at: iso(shippedAt), status: "label_created", location: "Portland, OR" },
      { at: iso(hoursAfter(shippedAt, 6)), status: "in_transit", location: "Portland, OR" },
    ]
    if (status === "delivered" || status === "out_for_delivery") {
      events.push({ at: iso(hoursAfter(shippedAt, 40)), status: "out_for_delivery" })
    }
    if (status === "delivered") {
      events.push({ at: iso(hoursAfter(shippedAt, 46)), status: "delivered", detail: "Left at front door" })
    }
    if (status === "exception") {
      events.push({ at: iso(hoursAfter(shippedAt, 30)), status: "exception", detail: "Address could not be verified" })
    }

    shipments.push({
      id: `shp_${order.id.slice(4)}`,
      orderId: order.id,
      carrier: pick(rand, CARRIERS),
      trackingNumber: `1Z${Math.floor(rand() * 1e15).toString(36).toUpperCase()}`,
      status,
      shippedAt: iso(shippedAt),
      estimatedDelivery: iso(hoursAfter(shippedAt, 48)),
      deliveredAt: status === "delivered" ? iso(hoursAfter(shippedAt, 46)) : undefined,
      events,
    })
  }

  // --- ordinary history -------------------------------------------------

  for (let d = HISTORY_DAYS; d > 0; d--) {
    const count = int(rand, 0, 2)

    // Draw the day's timestamps first and sort them, so order numbers stay
    // monotonic with time. Numbering in creation order with random times
    // would let CR-1043 predate CR-1042 within the same day.
    const times = Array.from({ length: count }, () =>
      daysAgo(anchor, d, int(rand, 8, 21), int(rand, 0, 59)),
    ).sort((a, b) => a.getTime() - b.getTime())

    for (const placedAt of times) {
      const customer = pick(rand, customers)
      const items = [{ product: pick(rand, products), quantity: int(rand, 1, 2) }]
      if (rand() > 0.7) {
        // A second line must be a *different* product — a real cart merges a
        // repeat pick into the existing line's quantity rather than listing
        // the same SKU twice.
        const second = pick(rand, products)
        if (second.id === items[0].product.id) items[0].quantity += 1
        else items.push({ product: second, quantity: 1 })
      }

      const roll = rand()
      const status: OrderStatus =
        d < 2 ? "paid"
        : d < 5 ? (roll > 0.5 ? "shipped" : "fulfilled")
        : roll > 0.92 ? "cancelled"
        : "delivered"

      const order = makeOrder({ customer, placedAt, status, items })

      // Exactly one shipment per order, and only once it has actually moved.
      // A small slice go wrong in transit instead of arriving.
      const troubled = rand() > 0.94
      if (status === "shipped") {
        makeShipment(order, placedAt, troubled ? "exception" : "in_transit")
      } else if (status === "delivered") {
        makeShipment(order, placedAt, troubled ? "exception" : "delivered")
      }
    }
  }

  // --- the seeded support story ----------------------------------------
  //
  // Dana Whitfield was charged twice for the same espresso machine: two
  // identical orders three minutes apart, from the same session. The first
  // shipped and was delivered. The second never left the warehouse.
  //
  // This is the situation the agent gets pointed at. Answering it requires
  // joining customer -> orders -> lines -> shipments, and *fixing* it means
  // issuing a refund — which the guard must stop and ask about.

  // Placed last so the pair carries the highest order numbers — order numbers
  // stay monotonic with time, the way a real store's would.
  const dana = customers[0]
  const espresso = products[0]
  const storyAt = daysAgo(anchor, 0, 9, 14)

  const first = makeOrder({
    customer: dana,
    placedAt: storyAt,
    status: "delivered",
    items: [{ product: espresso, quantity: 1 }],
    channel: "web",
  })
  makeShipment(first, storyAt, "delivered")

  const duplicate = makeOrder({
    customer: dana,
    placedAt: new Date(storyAt.getTime() + 3 * 60_000),
    status: "paid",
    items: [{ product: espresso, quantity: 1 }],
    channel: "web",
    notes: "Customer reports being charged twice. Second order never fulfilled.",
  })

  // --- derived rollups ---------------------------------------------------

  for (const c of customers) {
    const own = orders.filter(o => o.customerId === c.id && o.status !== "cancelled")
    c.orderCount = own.length
    c.lifetimeValueCents = own.reduce((s, o) => s + o.totalCents, 0)
  }

  adjustments.push({
    id: "adj_1",
    productId: espresso.id,
    delta: -2,
    reason: "Warehouse count correction",
    createdAt: iso(daysAgo(anchor, 4)),
    createdBy: "yousef@crate.com",
  })

  return {
    staff, customers, addresses, products, orders, shipments, refunds, adjustments,
    story: {
      deliveredOrderNumber: first.number,
      duplicateOrderNumber: duplicate.number,
      customerId: dana.id,
    },
  }
}
