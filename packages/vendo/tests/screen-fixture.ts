import { sha256Hex, VENDO_APP_FORMAT, type AppDocument, type AppId } from "@vendoai/core";
import { SCREEN_FILE } from "@vendoai/apps";

/** The smallest screen the gauntlet passes and the seam paints. */
export const FIXTURE_SCREEN = `import { Stack, Text } from "@vendo/screen";

export default function Dash() {
  return (
    <Stack gap={12}>
      <Text text="Ready" variant="heading" />
    </Stack>
  );
}
`;

/** The app's own source file, spelled the way `commitApp` spells it. */
export const screenSource = (text = FIXTURE_SCREEN): NonNullable<AppDocument["source"]> => ({
  [SCREEN_FILE]: {
    hash: `sha256:${sha256Hex(text)}`,
    bytes: new TextEncoder().encode(text).byteLength,
    text,
  },
});

/** A stored app as the product writes one: it IS its `app.tsx`. */
export const screenDocument = (id: string, over: Partial<AppDocument> = {}): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: id as AppId,
  name: "Dash",
  ui: "tree",
  source: screenSource(),
  ...over,
});
