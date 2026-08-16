---
"@vendoai/ui": minor
---

The ui test suite comes under the typechecker.

`packages/ui` was the only package of fourteen whose tests never typechecked. `tsconfig.test.json` existed but its `include` was scoped to the `*.test-d.tsx` type-level suites, because the runtime tests under `test/` carried 135 pre-existing errors. The include now covers all of `test/`, and `pnpm typecheck` is clean over it — so a ui test can no longer be quietly wrong about the API it exercises.

The errors were fixed, not silenced: no `any`, no `@ts-ignore`, no `@ts-expect-error`. Six kinds of debt came out of it — fixtures that never learned about a field the type gained (`risks`, `triggerId`, `Trigger.id`, `ToolDescriptor.description`, `VendoAppRef.status`), fixtures still naming a field the type had dropped or renamed (`GrantSetPermission.description`, `ToolDescriptor.critical` → `confirmEach`), imports pointing at the wrong module (`Thread`, `VENDO_TREE_FORMAT`, `InClientVenue`), tree fixtures declaring themselves `UIPayload` while being handed to `TreeView`'s `WalkTree` prop, DOM reads that ignored `noUncheckedIndexedAccess`, and helpers whose parameter types had been inferred from one call site. No assertion changed meaning and no test was added or removed; all 1206 still pass.

One type widened as a result. `HostComponentsInput` was `Record<string, ComponentType> | ComponentRegistry`, which rejected every host component that declares required props — `ComponentType` defaults its props to `{}` — and could not express a map mixing a plain component with a registry entry, which is exactly what `hostComponentMap` has always read per entry. It is now `Record<string, ComponentType<never> | ComponentRegistryEntry>`. Purely a widening: everything that typechecked before still does, and nothing at runtime changed.
