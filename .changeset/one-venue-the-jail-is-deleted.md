---
"@vendoai/apps": major
"@vendoai/ui": major
"@vendoai/actions": patch
"@vendoai/mcp": patch
---

One venue — the island jail and its apparatus are deleted.

Model-written code runs in the QuickJS empty room; host-written or human-reviewed code runs native. The double-iframe jail was a third answer, so it goes, and with it its runtime bundle, the ambient island scope, the esm.sh escape hatch, the smoke-render gate and the island syntax gate.

**Removed from `@vendoai/ui/tree`:** `JailedComponent` and `JailedComponentProps`. The renderer keeps ONE venue: a granted `source: "generated"` node mounts in the host page, an ungranted one drops back to a contained notice. With one venue left, `BoundMode` is gone from `bindValue`/`bindProps`, and the per-island tool manifest and `themeVars` go with the frame that read them.

**Renamed on `@vendoai/ui/tree`:** `JailFurnishing`, `JailSubSource` and `JailStyle` are `InClientFurnishing`, `InClientSubSource` and `InClientStyle` — minus `packages`, which only ever fed the CDN loader.

**Removed from `@vendoai/apps/contract`, outright:** `JAIL_PACKAGE_CDN_ORIGIN`, `jailPackageUrl`, `ISLAND_AMBIENT_NAMES`, `ISLAND_AMBIENT_REACT_NAMES`, `ISLAND_AMBIENT_KIT_NAMES`, `ISLAND_AMBIENT_HELPER_NAMES`, `IslandAmbientName`, `ISLAND_STRIPPED_SPECIFIERS`, `ISLAND_RESOLVABLE_SPECIFIERS`, `IslandResolvableModule`, `isStrippedIslandSpecifier`, `IslandImportStrip`, `stripIslandImports`, `blankNonCode`, `islandVendoActionNames`, `islandNetworkViolations` and `islandToolFallbackManifest`.

**Renamed on `@vendoai/apps/contract`:** `JAIL_ALLOWED_MODULES` is `IN_CLIENT_ALLOWED_MODULES`, `JailModule` is `InClientModule`, `JAIL_BUNDLED_PACKAGES` is `IN_CLIENT_BUNDLED_PACKAGES`, `JailBundledPackage` is `InClientBundledPackage`, and `isPinnedJailPackage` is `isPinnedPackage`. `isIslandResolvableSpecifier`, `scanIslandTools`, `IslandToolScan` and `resolveIslandToolName` stay: `contract/island-ambient.ts` became `contract/screen-tools-scan.ts`, trimmed to the `tools` literal-access scan the tsx door runs and the resolvable-specifier set sync capture asks about. `contract/jail-modules.ts` became `contract/inclient-modules.ts`.

Two files behind the gate go with it — `server/checking/islands.ts` and `server/checking/smoke-render.ts` — and so do the relocations you should not notice: `jail/viewport-css.ts` to `tree/viewport-css.ts`, `jail/zod-shim.ts` to `tree/inclient-zod-shim.ts` (`JailZodShimError` is `ZodShimError`; both are internal).

**One fix rides along.** The jail applied `themeVars` from React context, so a generated screen was themed by where its PROVIDER was, not by where its DOM was. With the jail gone, theming rides DOM ancestry — and a bare `<AppFrame>` mounted outside chrome resolved every `--vendo-*` to the empty string and fell back to the porcelain defaults. The surface root is already a boundary, so it declares the theme too, through the same `themeCssVariables()` mapping chrome, the overlay, the approval sheet and the toasts use. Nested in chrome it restates identical values, so there is one mapping and nothing that can disagree.

`@vendoai/actions` only follows the rename in its closure capture — `CapturedClosure` and `previewBlockingSpecifiers` are unchanged. `@vendoai/mcp` ships its regenerated shim artifact, 4.09 MB down to 3.05 MB.
