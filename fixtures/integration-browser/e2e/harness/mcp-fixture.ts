import type { AppDocument } from "@vendoai/core";

export const MCP_APPS_SUBJECT = "user_ada";
export const MCP_APPS_FIXTURE_ID = "app_mcp_browser_fixture";
export const MCP_APPS_INVOICE_ID = "inv_0003";
export const MCP_APPS_UPDATED_MEMO = "Updated over MCP Apps";

const invoiceActions = `
import React from "react";

export default function InvoiceActions({ onUpdate, onDelete }) {
  const [updateState, setUpdateState] = React.useState("Update has not run");
  const [deleteState, setDeleteState] = React.useState("Delete has not run");
  const button = {
    border: 0,
    borderRadius: 10,
    padding: "10px 14px",
    fontWeight: 650,
    cursor: "pointer",
  };

  async function updateInvoice() {
    const outcome = await onUpdate();
    setUpdateState("Updated: " + outcome.status);
  }

  async function deleteInvoice() {
    const outcome = await onDelete();
    setDeleteState("Delete: " + outcome.status);
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <button
          type="button"
          onClick={updateInvoice}
          style={{ ...button, color: "white", background: "#3156d9" }}
        >
          Update invoice
        </button>
        <button
          type="button"
          onClick={deleteInvoice}
          style={{ ...button, color: "#8f1f1f", background: "#fee7e7" }}
        >
          Delete invoice
        </button>
      </div>
      <div aria-live="polite" style={{ display: "grid", gap: 4, color: "#535766", fontSize: 13 }}>
        <span>{updateState}</span>
        <span>{deleteState}</span>
      </div>
    </div>
  );
}
`;

/** A real stored rung-1 app whose generated controls exercise the shim's
 * nested jail, MCP Apps host bridge, door tools, app runtime, guard, and host. */
export const mcpBrowserFixture: AppDocument = {
  format: "vendo/app@1",
  id: MCP_APPS_FIXTURE_ID,
  name: "MCP invoice control",
  description: "A browser-driven MCP Apps ride-along fixture.",
  components: { InvoiceActions: invoiceActions },
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Surface", source: "prewired", children: ["layout"] },
      {
        id: "layout",
        component: "Stack",
        source: "prewired",
        props: { gap: 14 },
        children: ["eyebrow", "title", "description", "divider", "actions"],
      },
      {
        id: "eyebrow",
        component: "Text",
        source: "prewired",
        props: { text: "LIVE MCP APPS RIDE-ALONG", variant: "caption" },
      },
      {
        id: "title",
        component: "Text",
        source: "prewired",
        props: { text: "MCP invoice control", variant: "heading" },
      },
      {
        id: "description",
        component: "Text",
        source: "prewired",
        props: { text: `Invoice ${MCP_APPS_INVOICE_ID} is rendered from the real door resource.` },
      },
      { id: "divider", component: "Divider", source: "prewired" },
      {
        id: "actions",
        component: "InvoiceActions",
        source: "generated",
        props: {
          onUpdate: {
            $action: "host_invoices_update",
            payload: { id: MCP_APPS_INVOICE_ID, memo: MCP_APPS_UPDATED_MEMO },
          },
          onDelete: {
            $action: "host_invoices_delete",
            payload: { id: MCP_APPS_INVOICE_ID },
          },
        },
      },
    ],
    data: { fixture: true, invoiceId: MCP_APPS_INVOICE_ID },
  },
};
