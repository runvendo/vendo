import { VENDO_APP_FORMAT, type AppId } from "@vendoai/core";
import type { AppDocument } from "../../contract/index.js";
import { SCREEN_FILE } from "../../contract/genui/component/index.js";
import { inlineSourceFile } from "../persistence/app-source.js";

/**
 * The smallest screen the gauntlet passes and the seam paints. It names no host
 * tool, so it opens on any deployment's catalog.
 */
export const FIXTURE_SCREEN = `import { Stack, Text } from "@vendo/screen";

export default function Dash() {
  return (
    <Stack gap={12}>
      <Text text="Ready" variant="heading" />
    </Stack>
  );
}
`;

/**
 * A stored app as the product writes one: it IS its `app.tsx`, spelled the way
 * `commitApp` spells it. What this package's tests build a real app row from.
 */
export const screenDocument = (id: AppId, over: Partial<AppDocument> = {}): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Dash",
  ui: "tree",
  source: { [SCREEN_FILE]: inlineSourceFile(FIXTURE_SCREEN) },
  ...over,
});
