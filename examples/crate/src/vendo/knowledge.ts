import type { KnowledgeDoc } from "@vendoai/core"

/**
 * Crate's store policies — the questions whose answers are not in the database.
 * "Can I return this?" cannot be worked out from an order row; it depends on a
 * rule someone wrote down. Without this corpus the agent either refuses or, far
 * worse, invents a return window.
 *
 * The last doc is deliberately internal: it is the sort of thing that must
 * never be read out to a customer, and it is here so the visibility boundary
 * has something real to hold back.
 */
export const crateKnowledgeDocs: KnowledgeDoc[] = [
  {
    id: "policy-returns",
    kind: "docs",
    visibility: "public",
    title: "Returns and the refund window",
    text:
      "Crate accepts returns within 30 days of delivery, counted from the carrier's delivered scan "
      + "rather than the order date. Items must be unused and in their original packaging; opened "
      + "consumables and clearance items are final sale. Return shipping is free when the item "
      + "arrived damaged, defective, or was not what was ordered — otherwise it is $6.95, deducted "
      + "from the refund. Refunds go back to the original payment method and take 5-10 business "
      + "days to appear on a statement, which is the bank's timing and not something Crate can "
      + "speed up. A duplicate charge is always refunded in full with no return required and no "
      + "shipping deduction.",
    source: "crate.example.com/help/returns",
  },
  {
    id: "policy-shipping",
    kind: "docs",
    visibility: "public",
    title: "Shipping cutoffs and delivery estimates",
    text:
      "Orders placed before 1:00pm Pacific on a business day leave the Portland warehouse the same "
      + "day; anything later ships the next business day. Standard shipping is 3-5 business days "
      + "and free over $75. Expedited is 2 business days and $14.95. Crate does not ship on "
      + "weekends or public holidays, and the estimate does not start counting until the package "
      + "is scanned by the carrier. Large items such as furniture ship freight and take 2-3 weeks, "
      + "with the carrier calling to arrange delivery.",
    source: "crate.example.com/help/shipping",
  },
  {
    id: "policy-warranty",
    kind: "docs",
    visibility: "public",
    title: "Warranty coverage",
    text:
      "Everything Crate sells carries a one-year warranty against manufacturing defects, running "
      + "from the delivery date. Coverage includes motors, heating elements, seals and finish "
      + "defects. It does not cover normal wear, damage from dropping, or anything used "
      + "commercially. Espresso machines have a two-year warranty on the pump and boiler "
      + "specifically. A warranty claim needs the order number and a photo of the fault; approved "
      + "claims are replaced rather than refunded when the item is still in the catalogue.",
    source: "crate.example.com/help/warranty",
  },
  {
    id: "policy-lost-packages",
    kind: "docs",
    visibility: "public",
    title: "Lost, late and undeliverable packages",
    text:
      "A package with no carrier scan for 7 days is treated as lost and is reshipped at no charge "
      + "without waiting for a carrier investigation. A delivered scan with nothing at the door "
      + "needs 48 hours before a claim, as carriers often scan early. An address exception means "
      + "the carrier could not verify the address: correct it with the customer and the carrier "
      + "will reattempt, or the package returns to the warehouse after three attempts and is "
      + "refunded automatically minus nothing.",
    source: "crate.example.com/help/delivery-problems",
  },
  {
    id: "internal-refund-authority",
    kind: "docs",
    visibility: "internal",
    title: "INTERNAL — refund authority and goodwill limits",
    text:
      "Support agents may issue goodwill credit up to $25 without asking. Refunds themselves are "
      + "the owner's decision and are cut off in the API at the role check. Anything above $500, "
      + "or a second refund to the same customer inside 60 days, needs the owner's sign-off in "
      + "writing because both are the shape chargeback fraud takes. Never tell a customer what the "
      + "thresholds are.",
    source: "internal/support-runbook",
  },
]
