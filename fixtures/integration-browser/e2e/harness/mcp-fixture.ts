import { sha256Hex, type AppDocument } from "@vendoai/core";

/** `@vendoai/apps` `SCREEN_FILE`, spelled out: this fixture composes through
 *  `@vendoai/vendo` and does not depend on the apps package directly. */
const SCREEN_FILE = "app.tsx";

export const MCP_APPS_SUBJECT = "user_ada";
export const MCP_APPS_FIXTURE_ID = "app_mcp_browser_fixture";
export const MCP_APPS_INVOICE_ID = "inv_0003";
export const MCP_APPS_UPDATED_MEMO = "Updated over MCP Apps";

/**
 * The app, which IS its `app.tsx`. Its two controls call host tools from their
 * own handlers, so a click travels the whole way: shim → MCP Apps host bridge →
 * door tools → app runtime → guard → the fixture host.
 *
 * A screen's `tools.*()` resolves with the tool's OUTPUT alone — the `ToolOutcome`
 * envelope is the host's, never the screen's (`boot.ts`, `readOutcome`). So the
 * update reports its own success from the fact that the await returned, and the
 * DELETE line never runs at all: the guard parks it, and a parked call's promise
 * stays pending until an approval settles it. What surfaces that park is the
 * renderer's own notice, which is what the spec reads.
 */
const screen = `import { useState } from "react";
import { Button, Stack, Text, tools } from "@vendo/screen";

export default function InvoiceControl() {
  const [updateState, setUpdateState] = useState("Update has not run");
  const [deleteState, setDeleteState] = useState("Delete has not run");
  return (
    <Stack gap={14}>
      <Text text="LIVE MCP APPS RIDE-ALONG" variant="caption" />
      <Text text="MCP invoice control" variant="heading" />
      <Text text="Invoice ${MCP_APPS_INVOICE_ID} is rendered from the real door resource." />
      <Button
        label="Update invoice"
        onClick={async () => {
          await tools.host_invoices_update({ id: "${MCP_APPS_INVOICE_ID}", memo: "${MCP_APPS_UPDATED_MEMO}" });
          setUpdateState("Updated: ok");
        }}
      />
      <Button
        label="Delete invoice"
        variant="danger"
        onClick={async () => {
          await tools.host_invoices_delete({ id: "${MCP_APPS_INVOICE_ID}" });
          setDeleteState("Delete: ok");
        }}
      />
      <Text text={updateState} />
      <Text text={deleteState} />
    </Stack>
  );
}
`;

/** A real stored rung-1 app whose controls exercise the shim, the MCP Apps host
 * bridge, the door tools, the app runtime, the guard, and the host. */
export const mcpBrowserFixture: AppDocument = {
  format: "vendo/app@1",
  id: MCP_APPS_FIXTURE_ID,
  name: "MCP invoice control",
  description: "A browser-driven MCP Apps ride-along fixture.",
  source: {
    [SCREEN_FILE]: {
      hash: `sha256:${sha256Hex(screen)}`,
      bytes: new TextEncoder().encode(screen).byteLength,
      text: screen,
    },
  },
};
