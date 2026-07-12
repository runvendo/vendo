# @vendoai/react

React bindings for Vendo: `VendoProvider`, `useVendoChat`, an in-memory `ChatTransport`, and `VendoStage` — the real sandboxed-stage renderer that replaced the non-production `StubRenderer` from F1.

Pairs with `@vendoai/core` and `@vendoai/stage`.

## VendoStage

`VendoStage` renders agent-generated `UINode` trees inside the `@vendoai/stage` sandboxed iframe. It owns the full stage lifecycle: mount, initialize, update, and teardown.

```tsx
import { VendoStage } from "@vendoai/react";

<VendoStage
  node={uiNode}
  bundleSource={hostBundleText}
  reactSource={reactShimText}
  theme={{ "--vendo-accent": "#0a7" }}
  state={{ balance: 1234.56 }}
  onAction={async (req) => myHandler(req)}
/>
```

Props:
- `node` — the `UINode` to render (from `@vendoai/core`). Pass `null` to render nothing.
- `bundleSource` — pre-fetched host bundle text (ESM, built with `vendoHostPreset`).
- `reactSource` — optional React ESM shim text; when provided, the sandbox imports React from a `blob:` URL instead of bundling it, so host bundle and runtime share one React instance.
- `theme` — canonical `--vendo-*` CSS variable tokens (`{ "--vendo-accent": "#0a7" }`), produced by `brandToCssVars`.
- `state` — scoped, structured-clone-safe state slice projected into the stage.
- `onAction` — handler for sandbox action dispatches; returns `ActionResult`.

The stage mounts once (on first render) and updates when `node` changes. Unmounting the component disposes the stage and removes the iframe.

## VendoProvider / useVendoChat

`VendoProvider` wraps your app and supplies the chat context. `useVendoChat` returns `{ messages, send, status }` for driving a conversation UI.

```tsx
import { VendoProvider, useVendoChat, InMemoryChatTransport } from "@vendoai/react";

const transport = new InMemoryChatTransport();

function App() {
  return (
    <VendoProvider transport={transport}>
      <Chat />
    </VendoProvider>
  );
}

function Chat() {
  const { messages, send } = useVendoChat();
  return <button onClick={() => send("Hello")}>Send</button>;
}
```
