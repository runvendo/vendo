# @flowlet/react

React bindings for Flowlet: `FlowletProvider`, `useFlowletChat`, an in-memory `ChatTransport`, and `FlowletStage` — the real sandboxed-stage renderer that replaced the non-production `StubRenderer` from F1.

Pairs with `@flowlet/core` and `@flowlet/stage`.

## FlowletStage

`FlowletStage` renders agent-generated `UINode` trees inside the `@flowlet/stage` sandboxed iframe. It owns the full stage lifecycle: mount, initialize, update, and teardown.

```tsx
import { FlowletStage } from "@flowlet/react";

<FlowletStage
  node={uiNode}
  bundleSource={hostBundleText}
  reactSource={reactShimText}
  theme={{ "--flowlet-accent": "#0a7" }}
  state={{ balance: 1234.56 }}
  onAction={async (req) => myHandler(req)}
/>
```

Props:
- `node` — the `UINode` to render (from `@flowlet/core`). Pass `null` to render nothing.
- `bundleSource` — pre-fetched host bundle text (ESM, built with `flowletHostPreset`).
- `reactSource` — optional React ESM shim text; when provided, the sandbox imports React from a `blob:` URL instead of bundling it, so host bundle and runtime share one React instance.
- `theme` — canonical `--flowlet-*` CSS variable tokens (`{ "--flowlet-accent": "#0a7" }`), produced by `brandToCssVars`.
- `state` — scoped, structured-clone-safe state slice projected into the stage.
- `onAction` — handler for sandbox action dispatches; returns `ActionResult`.

The stage mounts once (on first render) and updates when `node` changes. Unmounting the component disposes the stage and removes the iframe.

## FlowletProvider / useFlowletChat

`FlowletProvider` wraps your app and supplies the chat context. `useFlowletChat` returns `{ messages, send, status }` for driving a conversation UI.

```tsx
import { FlowletProvider, useFlowletChat, InMemoryChatTransport } from "@flowlet/react";

const transport = new InMemoryChatTransport();

function App() {
  return (
    <FlowletProvider transport={transport}>
      <Chat />
    </FlowletProvider>
  );
}

function Chat() {
  const { messages, send } = useFlowletChat();
  return <button onClick={() => send("Hello")}>Send</button>;
}
```
