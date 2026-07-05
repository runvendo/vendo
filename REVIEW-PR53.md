# PR #53 Review

## Findings

1. **major** - `packages/vendo-next/src/client/vendo-root.tsx:125`

   `ScopedPinOverlay` persists only `{ anchorId, node, components }` when the new scoped pin affordance is used. The existing chat "Apply to page" path persists the paired sealed remix `envelope` (`packages/vendo-shell/src/VendoThread.tsx:195`), and `VendoRemix` later sends that envelope back on scoped opens so the server can edit `base: "pin"` instead of starting from the original anchor. Because `onPin` only receives a `UINode`, and the envelope lives beside the node on the thread item rather than inside `UINode`, pins created through this new path silently lose fast-edit state.

   Suggested fix: extend the pin path to carry the envelope, for example by changing the shell `onPin` callback shape to include `envelope?: string`, tracking the latest UI item rather than only `latestNode`, and passing `{ envelope }` into `remixes.pin` when present. Add a scoped-pin regression test that pins an enveloped remix and verifies the next `VendoRemix` scoped open carries that envelope.

2. **minor** - `apps/demo-accounting/src/components/vendo/VendoLayer.tsx:70`

   The scoped pin wrapper is private to `@vendoai/next`'s `VendoRoot`, but Cadence mounts `VendoOverlay` directly inside its custom root while also using `VendoRemix` anchors. That call site bypasses `ScopedPinOverlay`, so the new scoped pin affordance is absent in the demo path most likely to exercise anchor-scoped overlays. The existing "Apply to page" flow still works, but the PR's new `onPin` behavior is not applied there.

   Suggested fix: move the scoped pin behavior into `VendoOverlay`/`VendoThread` in `@vendoai/shell`, or export a reusable wrapper and update direct overlay call sites such as Cadence's `VendoLayer`. Cover at least one direct-`VendoOverlay` + `VendoRemix` integration test.

3. **minor** - `packages/vendo-server/src/fetch-handler.ts:261`

   The host-events runtime behavior is covered only below the server boundary. Runtime tests validate `createAutomationTools({ hostEvents })`, and instruction tests validate `buildAutomationInstructions`, but there is no server-level regression test proving `.vendo/tools.json` `events` flow through `loadVendoDir` into both `createAutomationsWorld(... hostEvents ...)` and the default prompt's `automationEvents`.

   Suggested fix: add a `fetch-handler` or `world` test with a temp `.vendo/tools.json` declaring a host event, then assert a `host_event` automation for that event is accepted while an undeclared event is rejected. Add an `agent.test` assertion that `automationEvents` fields appear in the default automation instructions.

## Verification

Original review verification:
- `pnpm install` passed; lockfile was already up to date.
- `packages/vendo-server`: `pnpm test` passed (247 tests), `pnpm build` passed.
- `packages/vendo-next`: `pnpm test` passed (71 tests), `pnpm build` passed.
- `packages/vendo-runtime`: `pnpm test` passed (747 passed, 4 skipped).
- Extra demo check: `apps/demo-bank pnpm test` passed (86 tests); `apps/demo-accounting pnpm test` passed (144 tests).

## FIXED

- Moved scoped pinning into `@vendoai/shell` in `packages/vendo-shell/src/VendoThread.tsx`: scoped chat "Pin to card" and `VoiceStage` pins now use the existing remix pin path, stamp host components, dispatch `REMIX_CHANGED_EVENT`, and preserve the paired sealed envelope when present.
- Kept explicit `onPin` as the slot-host override; when provided, it receives the latest `UINode` exactly as before and bypasses scoped remix persistence.
- Removed the private `ScopedPinOverlay` wrapper from `packages/vendo-next/src/client/vendo-root.tsx`; `VendoRoot` now renders `VendoOverlay` directly while keeping the gated `voice` prop pass-through intact.
- Added shell regressions for scoped envelope preservation and `onPin` override behavior in `packages/vendo-shell/src/VendoThread.test.tsx`.
- Added server regressions proving `.vendo/tools.json` events flow into automation closed-world validation, plus prompt coverage for `automationEvents`, in `packages/vendo-server/src/fetch-handler.test.ts` and `packages/vendo-server/src/agent.test.ts`.

Post-fix verification:
- `packages/vendo-shell`: `pnpm test` passed (332 tests).
- `packages/vendo-next`: `pnpm test` passed (71 tests).
- `packages/vendo-server`: `pnpm test` passed (249 tests).
- Root: `pnpm build` passed (19 tasks), including `demo-bank` and `demo-accounting`; only existing bundle/tracing warnings were reported.

Verdict: MERGE
