import { Button, Callout, Stack, Stat, Surface } from "@vendoai/ui/kit";
import { useState } from "react";
import { callFn } from "./fn.js";

/**
 * The app. THIS is the file to edit.
 *
 * It is real, working code — full TypeScript and React, with the whole Kit
 * available from `@vendoai/ui/kit`. There is no template language and no
 * restricted subset: `tsc`, the dev server's errors and `vite build` are the
 * code validators, and they all run in the box.
 *
 * Two data paths, and they are not interchangeable:
 *  - `callFn` reaches THIS app's own server half (../fns.js), for anything the
 *    app computes or stores itself.
 *  - the guarded hooks from `@vendoai/ui/kit` reach the HOST's tools through the
 *    wire, with the viewer's own session and the guard's approvals intact.
 */
export function App() {
  const [pinged, setPinged] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  return (
    <Stack gap={16}>
      <Surface title="Your Vendo app">
        <Stack gap={12}>
          <Stat label="Starting point" value="Edit src/App.tsx" />
          <Button
            label="Call an fn"
            onClick={() => {
              setFailure(undefined);
              callFn<{ ok: boolean }>("ping")
                .then((result) => setPinged(String(result?.ok)))
                .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
            }}
          />
          {pinged === undefined ? null : <Stat label="ping" value={pinged} />}
          {failure === undefined ? null : <Callout tone="danger" title="That call failed">{failure}</Callout>}
        </Stack>
      </Surface>
    </Stack>
  );
}
