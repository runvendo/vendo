# @vendoai/ui

## 0.26.0

### Patch Changes

- Updated dependencies [c369e14]
- Updated dependencies [443edd4]
  - @vendoai/core@0.26.0
  - @vendoai/apps@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [aa1c8db]
  - @vendoai/core@0.25.0
  - @vendoai/apps@0.25.0

## 0.24.0

### Minor Changes

- 42b2b78: The Kit implements the 34 slots the table was shrunk to leave out.

  `SLOTS` shipped at what the React Kit actually painted — two of thirty-seven — because a declared slot the component drops is worse than no slot at all: the prompt teaches it, every check admits it, and the person gets a blank. The rest were deferred, not descoped. They land here, table entry and implementation together, and `slot-drift.test.tsx` renders a probe into every one of them and fails unless it finds it in the DOM.

  New places to write an element: a `header` and `footer` on Surface, Card and (with `actions`) Form; a `toolbar`, per-row `rowActions` and `empty` on DataTable; `actions` and `empty` on CardList; `empty` on Timeline; `empty`, `legend` and a per-point `tooltip` on LineChart, BarChart and DonutChart; `icon` on Stat; `marker` on Steps; `actions` on Tabs; `prefix`, `suffix` and `hint` on Input; `hint` and a `footer` on Textarea; `hint` on DatePicker; `label` on Divider. Four props widen from a scalar to take an element as well as the value they took before — `Progress.label`, `EmptyState.icon` (still a lucide name when it is a string), `DonutChart.legend` (still `false` to take the built-in key away), and each control's `hint`.

  A chart's `tooltip` publishes the hovered point on `RowContext`, so the value components inside name their field exactly as a table cell's do — the cell contract, per point. It renders through a function rather than as a bare element, because recharts clones whatever element it is handed with eighteen of its own internal props and React writes every one of them onto the DOM node.

  An `empty` slot replaces the container's dashed box rather than its text: what goes in one is an `EmptyState`, which draws that frame itself, and nested it read as a box inside a box.

  Every slot also gets its entry in the component's `props`, the way `Timeline.cell` and `Timeline.marker` already had one. The screen typings and the wire's allowed-prop set are printed from `props` alone, so a slot declared only in `SLOTS` is one the catalog teaches and `components-exist` then refuses by name. **This fixes `Modal.header`, `Modal.footer`, `Sheet.header` and `Sheet.footer`, which are in that state on `main` today** — declared, taught, painted, and blocked at the floor. A new sweep pins the rule for every slot there will ever be.

  `Select.hint` is the one slot from the worklist not implemented here.

- b4dd54d: The ui test suite comes under the typechecker.

  `packages/ui` was the only package of fourteen whose tests never typechecked. `tsconfig.test.json` existed but its `include` was scoped to the `*.test-d.tsx` type-level suites, because the runtime tests under `test/` carried 135 pre-existing errors. The include now covers all of `test/`, and `pnpm typecheck` is clean over it — so a ui test can no longer be quietly wrong about the API it exercises.

  The errors were fixed, not silenced: no `any`, no `@ts-ignore`, no `@ts-expect-error`. Six kinds of debt came out of it — fixtures that never learned about a field the type gained (`risks`, `triggerId`, `Trigger.id`, `ToolDescriptor.description`, `VendoAppRef.status`), fixtures still naming a field the type had dropped or renamed (`GrantSetPermission.description`, `ToolDescriptor.critical` → `confirmEach`), imports pointing at the wrong module (`Thread`, `VENDO_TREE_FORMAT`, `InClientVenue`), tree fixtures declaring themselves `UIPayload` while being handed to `TreeView`'s `WalkTree` prop, DOM reads that ignored `noUncheckedIndexedAccess`, and helpers whose parameter types had been inferred from one call site. No assertion changed meaning and no test was added or removed; all 1206 still pass.

  One type widened as a result. `HostComponentsInput` was `Record<string, ComponentType> | ComponentRegistry`, which rejected every host component that declares required props — `ComponentType` defaults its props to `{}` — and could not express a map mixing a plain component with a registry entry, which is exactly what `hostComponentMap` has always read per entry. It is now `Record<string, ComponentType<never> | ComponentRegistryEntry>`. Purely a widening: everything that typechecked before still does, and nothing at runtime changed.

### Patch Changes

- Updated dependencies [42b2b78]
  - @vendoai/apps@0.24.0
  - @vendoai/core@0.24.0

## 0.23.0

### Patch Changes

- @vendoai/core@0.23.0
- @vendoai/apps@0.23.0

## 0.22.0

### Patch Changes

- @vendoai/core@0.22.0
- @vendoai/apps@0.22.0

## 0.21.0

### Minor Changes

- 6856b4f: Display bricks — the HTML a screen may write, contained by its box.

  A screen had exactly one vocabulary: the Kit. Every arrangement it could not express had to be faked with a container that was never meant for it, and `<div>` was a type error. A screen now has ~21 display-only tags beside the Kit — `div`, `span`, `section`, `header`, `footer`, `aside`, `h1`–`h6`, `p`, `strong`, `em`, `small`, `code`, `blockquote`, `ul`, `ol`, `li` — each taking children and an inline `style`, and nothing else. Free CSS, off the host's own theme variables.

  `DISPLAY_SPECS` and `DISPLAY_TAG_NAMES` are new on `@vendoai/apps/contract` (kit) and are the single source: the renderer resolves bricks beside `KIT_COMPONENTS`, the screen typings print them as the ONLY `JSX.IntrinsicElements` (so `<img>` and `<script>` stay errors, and `className` is an error on the tag), the type-check refusal names the legal tags, the tree's catalog check skips them like a text run, and the prompt and format reference teach them.

  Security stays capability-shaped, never content-inspected. There is no style validator and no provenance scanner:

  - Each brick is written out by hand and destructures exactly `style` and `children`. No spread, so `className`/`id`/`on*`/`data-*`/`aria-*`/`dangerouslySetInnerHTML` cannot arrive — not because a list refuses them, but because nothing carries them.
  - ONE trusted-side filter drops the declarations that would FETCH (`url()`, `src()`, `image-set()`). A screen has no network; a beacon is a beacon whatever the URL says. The filter normalizes before it tests, the way the CSS tokenizer does: input preprocessing (CRLF, lone CR and form feed to one newline; NUL and lone surrogates to U+FFFD) and then escape resolution, so `\75 rl(`, `u\72 l(`, the fully-escaped spelling and every one of those routed through a custom property are caught — all reproduced fetching in real Chromium first. Honest framing: this closes every bypass we can demonstrate. It is a normalization pass, not a proof of completeness.
  - The surface root paints inside its own box: `contain: layout paint; overflow: clip; position: relative; isolation: isolate`. `contain: paint` makes it the containing block for fixed descendants, so `position: fixed; width: 200vw` is held by geometry — nothing read the word "fixed".

  One inert value changes side: `url\9 (` never fetched (whitespace between the ident and `(` is no function token), and normalizing puts a tab where the escape was, which the filter's `\s*` takes. It is pinned as dropped — buying it back would cost a second mechanism for a value that paints nothing.

- 6fd3bfa: Dock the conversation panel beside the product — opt-in.

  `VendoOverlay` takes a `placement` prop. `"dock"` parks the panel against the
  right edge at full height and reflows the host page into the remaining width,
  so the surface being reshaped stays visible and clickable while the panel is
  open. `dockWidth` (default `420`) sets the panel width and, with it, how far
  the page reflows. Below the mobile breakpoint both still collapse to the
  full-bleed takeover.

  `placement` defaults to `"center"`, the centered modal that has always
  shipped, so this release changes nothing for an existing host: the scrim, the
  body scroll-lock, `inertBehind` and `aria-modal` are all still there unless a
  host asks for `placement="dock"`.

  Docked is deliberately NON-modal — no scrim, no body scroll-lock, no
  `inertBehind`, no focus trap, and no `aria-modal` — because a modal that
  covers the page is the wrong shape for a tool whose job is editing that page.
  The page reflows via a width reduction on `documentElement` (not `body`,
  whose width is usually author-controlled), torn down on close, unmount, and
  placement flips. Host chrome that is itself `position: fixed` is anchored to
  the viewport rather than to `documentElement`, so it does not reflow with
  this; such elements can read `--vendo-dock-w` to inset themselves.

  The reflow is owned centrally and refcounted: `data-vendo-dock` and
  `--vendo-dock-w` live on the one `documentElement` every overlay shares, so
  closing one of two open docked panels no longer hands the page back its full
  width while the other is still open.

  The workspace expander stays a centered-placement feature — a full-height rail
  has nowhere to grow a stage into — so it is hidden while docked. For the same
  reason a docked conversation does not auto-stage a built app: staging on the
  user's behalf there would strand an app they could neither see nor collapse.
  The embed still lands in the rail.

  **An indeterminate progress bar** sweeps along the top edge of the framed page
  while a turn runs, driven by the existing cross-tree run-activity store. No
  percentage: `RunActivity`'s `done`/`total` count steps already begun, not a
  forecast, and inventing a completion estimate would break the same "no fake
  percentage, no completion jump" rule the app-boot hairline already follows.

  Public API added: `placement` and `dockWidth` on `VendoOverlay`.

- 46aee4a: Host fonts become bytes, not just a name.

  Theme extraction learned that the brand font is called "Inter". That name is
  enough for the host's own pages and useless everywhere else: a generated screen
  renders inside surfaces the host's stylesheet never reaches, where "Inter"
  resolves to whatever the surface happens to have — normally nothing.

  - **`vendo sync` now writes `.vendo/fonts.css`** — the theme's families resolved
    to real files and inlined as data-URI `@font-face` rules. Three sources, in
    order of how much each proves about what the host actually ships: next/font's
    build output, the host's own `@font-face` rules pointing under `public/`, then
    the Google Fonts css2 API. The first and last are re-resolved on every run and
    never recorded — next/font's filenames carry a per-build hash and gstatic's
    carry a font version, so a stored path is a path that rots. Written with
    `theme.json` and only then (install, and any sync where the brand actually
    moved), because resolving a face can reach the network and `sync` runs from
    `predev`. `init` prints the one-line import beside the `<VendoProvider>` paste.
  - **`theme.json` gets metadata, never bytes** — `typography.fonts` names each
    face's family/weight/style/source. The file is a bundle import and rides the
    `?vendoTheme=` query string, where a base64 face would blow past every proxy's
    request-line limit.
  - **A host's real mono font is learned instead of discarded.** The body-stack
    derivation found the mono binding, filtered it out of the sans candidates and
    dropped it, so a host shipping Geist Mono still got the generic system stack.
    It is now derived on its own and stored as `typography.monoFamily`, falling
    back to `monospace` rather than `sans-serif` — a code font that fails to load
    must fall back to another code font.
  - **`VendoProvider` takes a `fonts` string** and the chrome injects it beside
    its own sheet, as a guarded `<style data-vendo-fonts>`. Kept separate from
    `ensureChromeStyles` on purpose: the faces and the chrome are wanted
    independently — a surface rendering inside someone else's client needs the
    faces and none of the chrome.

  - **Sync no longer captures its own output.** The root layout now imports
    `.vendo/fonts.css`, and the seed-baseline style capture would have read that
    sheet straight back in — ~65 KB of base64 copied into every remixable seed and
    host-component bundle, on every run. `.vendo/` is sync's output, never host
    source, and the capture skips it.

  Only latin is taken, and only because both sources already publish per-subset
  files. No glyph-subsetting machinery ships, and there is no license logic.

- 83aec51: The Kit gets an `Icon`. Generated screens have had no way to draw a glyph, so
  every affordance has been a word — and the models reach for `lucide-react`
  anyway, which the jail cannot resolve.

  `<Icon name="arrow-up-right"/>` renders an inline stroked SVG that inherits the
  surrounding text's color. 227 names, in lucide's own kebab-case, are extracted
  at build time by `pnpm --filter @vendoai/ui build:icons` into the committed
  `src/kit/icons.gen.ts`; lucide itself is a devDependency, so the runtime carries
  the path data and never the package. A name outside the set renders nothing and
  marks itself `data-kit-missing-icon` — a guessed glyph leaves a gap, never a
  crash and never a broken-glyph box.

- 01e225c: Overlay bricks — Modal, Sheet and Toast — plus the Kit's first stylesheet.

  The three bricks paint outside the screen's own box, on Base UI's Dialog and
  Toast, so the focus trap, Esc and the page's scroll lock come from the library
  rather than from hand-rolled listeners. `KitOverlaySpec` names the open/close
  pair that makes an overlay an overlay, and `KIT_OVERLAY_SPECS` is how a consumer
  routes one without matching on a component name.

  The renderer reads that map: an overlay node paints on the body-level host, so
  its box in the tree generates nothing, and the Stack it was written in no longer
  carries an empty gap where the overlay used to sit.

  `KIT_CSS` is the Kit's first document-level stylesheet, and it carries nothing
  but pseudo-class state — hover, focus-visible and the press, keyed on `data-kit`.
  Everything themable stays inline on the brick. The sheet is injected from the
  tree surface itself, so every generated screen has hover and focus states —
  not only the ones that happen to raise an overlay.

- 0c27a89: Quiet Precision — every Kit brick restyled against the theme v2 tokens.

  The Kit had its taste written in literals: `1px solid`, `fontWeight: 650`, four
  different hand-rolled `box-shadow` blurs, `letterSpacing: "-0.011em"` copied
  into six files. A host that set `borderWidth`, `weightEmphasis` or `shadow.small`
  changed nothing, because nothing read them.

  Now one edge, one lift, one type ramp, and all three come off the host's theme:

  - `hairline` is the ONE edge — `--vendo-border-width` over `--vendo-color-border`.
    Borders do the work shadows used to, so Card, Surface, CardList and the tabs
    indicator are flat. The single remaining lift is a filled Button, and it paints
    `--vendo-shadow-small` rather than a literal.
  - `microLabel` is the ONE micro-label — letterspaced uppercase, for the things
    that are chrome and not content: a column header, a table caption, a Stat's
    metric name, a Progress label, `<Text variant="label">`. Caption text stays
    sentence-case; it carries model-authored sentences.
  - Weights, line-heights and letter-spacing come from
    `--vendo-font-weight-normal/-emphasis`, `--vendo-line-height(-heading)` and
    `--vendo-letter-spacing`, so a brand's type voice reaches the Kit.
  - Figures are tabular everywhere — the whole DataTable, not just its formatted
    columns.
  - `transitionFor()` builds every transition on `--vendo-motion-duration` and
    `--vendo-motion-easing`, so `motion: "reduced"` (which emits `0ms`) collapses
    the tabs glide, the accordion chevron and the progress fill with no branch.
  - A neutral Stat loses its 3px rule: `toneColor("neutral")` is the foreground
    itself, and a near-black bar on every resting tile is the opposite of quiet.
    A toned tile keeps it.
  - Chart tooltips and axis ticks read the tokens instead of re-spelling them.

  No prop changed on any brick. The `fluidkit` and `motion` dependencies, the
  vitest alias that stubbed them and `test/mocks/fluidkit.tsx` are deleted — the
  last import of either was gone.

- d9b7c8d: The Kit's `cell` slot generalizes: a component now DECLARES its slots, and the
  checks floor reads that declaration instead of one hard-coded prop name.

  `KitComponentSpec` gains `slots?: Record<string, KitSlotSpec>` — a doc, an
  optional `content` vocabulary and a `perRow` flag per slot — and one table in
  `specs.ts` states every place the Kit takes an element instead of a value:
  `cell` where it already lived (a DataTable column, a CardList field, a KeyValue
  field), `cell` and `marker` on Timeline, and the `content` on a Tabs panel and an
  Accordion section. Every other component declares none, and takes no element at
  all.

  The table states only what the React Kit RENDERS. A slot the components do not
  implement is worse than no slot: the prompt teaches the model to write it, every
  check passes it, and the renderer drops it in silence — the same breakage the
  table exists to refuse, arriving through the table. `@vendoai/ui`'s `test/kit/slot-drift.test.tsx` puts a probe in every
  declared slot and fails unless it finds it in the DOM, so the declaration and
  the implementation move together.

  The `kit-nesting` check reads that table: an element in a declared slot is
  measured against the slot's own vocabulary — the read-only value tier by
  default, so a Button in a per-row `cell` is refused exactly as before — and an
  element under a key no slot declares is refused by name instead of reaching a
  renderer that would drop it. Tabs' and Accordion's element-valued `content`,
  unchecked until now, goes through the same gate. `kitPrompt` prints the slots
  from the same declaration, so the model is taught the table the floor enforces.

  A slot is read at its DECLARED path and nowhere else. Each entry says where it
  sits (`at: "columns"` → `columns[].cell`), and both the prompt and the check use
  that one string — so a `cell` field on a ROW, which a DataTable never looks at,
  is refused by name instead of being admitted as if it were the column's.

  A component sitting in a slot is measured against its OWN spec, not just the
  outer slot's vocabulary. It is a component in its own right: an element in a
  prop it has no slot for, and children under a component that renders none, are
  now refused inside a slot exactly as they are at the top of the tree. Both had
  passed clean while the renderer dropped the descendant.

  The renderer closes the matching gap: an element in a slot resolved only the
  Kit, while the CHILDREN path resolved the Kit and the display bricks, so a brick
  tag written into a slot painted nothing at all. `reifyElement` now reads the
  same two registries `builtinContent` does.

- 5932631: Six static bricks join the Kit, for the shapes a screen could only fake with a
  Stack and a Text: `KeyValue`, `Timeline`, `Avatar`, `CodeBlock`, `EmptyState`
  and `Steps`.

  `<KeyValue record items/>` lays ONE record out as label/value rows — the detail
  a table row expands into — and `<Timeline entries/>` runs a record history down
  a dotted spine. Both take a `cell` slot on the DataTable contract: the slot
  holds an element, the container publishes the record, and the components inside
  name their field. `<Avatar name/>` draws initials in a tint hashed off the name,
  so one person is one color everywhere, and adjacent avatars in a `Row` stack.
  `<CodeBlock code language/>` shows a payload verbatim — no highlighting, no copy
  button. `<EmptyState icon title description>` is the designed nothing-here with
  the action that fixes it nested inside, and `<Steps items active/>` is the
  progress trail, horizontal or vertical.

  Every one is themed through the host's own `--vendo-*` variables and reads the
  new `--vendo-border-width`, `--vendo-mono-family` and `--vendo-color-surface-raised`
  tokens through a fallback, so an unthemed host is unchanged.

- 89f2843: Tabs runs on Base UI.

  `@base-ui/react` (pinned `1.7.0`) is now a dependency of the Kit, and `Tabs` is
  the first brick built on it: `Tabs.Root` / `List` / `Tab` / `Panel` replace the
  hand-rolled tablist, so the roving tab order, the arrow/Home/End walk and the
  tab↔panel `aria-controls` / `aria-labelledby` wiring come from the library
  instead of from ~40 lines of this repo's own keyboard code.

  `TabsProps` is unchanged to the byte, and so is the rendering: the Quiet
  Precision inline styles moved onto Base UI's parts through its `style`-as-state
  callback, which is how the selected tab's accent, fill and rule survive with no
  stylesheet. Before/after screenshots of the bar in a real Chromium are
  pixel-identical.

  One behavior moved. A disabled tab is now reachable with the arrow keys (Base
  UI marks it `aria-disabled` and leaves it in the roving order, for
  discoverability) where the old bar skipped over it. It still cannot be
  selected, by click or by Enter.

  `Checkbox` and `Select` stay on their native elements — see the PR for why.

- 6856b4f: One venue — the island jail and its apparatus are deleted.

  Model-written code runs in the QuickJS empty room; host-written or human-reviewed code runs native. The double-iframe jail was a third answer, so it goes, and with it its runtime bundle, the ambient island scope, the esm.sh escape hatch, the smoke-render gate and the island syntax gate.

  **Removed from `@vendoai/ui/tree`:** `JailedComponent` and `JailedComponentProps`. The renderer keeps ONE venue: a granted `source: "generated"` node mounts in the host page, an ungranted one drops back to a contained notice. With one venue left, `BoundMode` is gone from `bindValue`/`bindProps`, and the per-island tool manifest and `themeVars` go with the frame that read them.

  **Renamed on `@vendoai/ui/tree`:** `JailFurnishing`, `JailSubSource` and `JailStyle` are `InClientFurnishing`, `InClientSubSource` and `InClientStyle` — minus `packages`, which only ever fed the CDN loader.

  **Removed from `@vendoai/apps/contract`, outright:** `JAIL_PACKAGE_CDN_ORIGIN`, `jailPackageUrl`, `ISLAND_AMBIENT_NAMES`, `ISLAND_AMBIENT_REACT_NAMES`, `ISLAND_AMBIENT_KIT_NAMES`, `ISLAND_AMBIENT_HELPER_NAMES`, `IslandAmbientName`, `ISLAND_STRIPPED_SPECIFIERS`, `ISLAND_RESOLVABLE_SPECIFIERS`, `IslandResolvableModule`, `isStrippedIslandSpecifier`, `IslandImportStrip`, `stripIslandImports`, `blankNonCode`, `islandVendoActionNames`, `islandNetworkViolations` and `islandToolFallbackManifest`.

  **Renamed on `@vendoai/apps/contract`:** `JAIL_ALLOWED_MODULES` is `IN_CLIENT_ALLOWED_MODULES`, `JailModule` is `InClientModule`, `JAIL_BUNDLED_PACKAGES` is `IN_CLIENT_BUNDLED_PACKAGES`, `JailBundledPackage` is `InClientBundledPackage`, and `isPinnedJailPackage` is `isPinnedPackage`. `isIslandResolvableSpecifier`, `scanIslandTools`, `IslandToolScan` and `resolveIslandToolName` stay: `contract/island-ambient.ts` became `contract/screen-tools-scan.ts`, trimmed to the `tools` literal-access scan the tsx door runs and the resolvable-specifier set sync capture asks about. `contract/jail-modules.ts` became `contract/inclient-modules.ts`.

  Two files behind the gate go with it — `server/checking/islands.ts` and `server/checking/smoke-render.ts` — and so do the relocations you should not notice: `jail/viewport-css.ts` to `tree/viewport-css.ts`, `jail/zod-shim.ts` to `tree/inclient-zod-shim.ts` (`JailZodShimError` is `ZodShimError`; both are internal).

  **One fix rides along.** The jail applied `themeVars` from React context, so a generated screen was themed by where its PROVIDER was, not by where its DOM was. With the jail gone, theming rides DOM ancestry — and a bare `<AppFrame>` mounted outside chrome resolved every `--vendo-*` to the empty string and fell back to the porcelain defaults. The surface root is already a boundary, so it declares the theme too, through the same `themeCssVariables()` mapping chrome, the overlay, the approval sheet and the toasts use. Nested in chrome it restates identical values, so there is one mapping and nothing that can disagree.

  `@vendoai/actions` only follows the rename in its closure capture — `CapturedClosure` and `previewBlockingSpecifiers` are unchanged. `@vendoai/mcp` ships its regenerated shim artifact, 4.09 MB down to 3.05 MB.

- 37ed821: Per-user limits: Vendo counts, the host decides.

  `createVendo({ limits })` takes one callback, asked once before each metered
  action — a user message, an app generation — with the resolved user, the action,
  and a `count(action, window?)` reader already bound to THAT user. Return `false`,
  or `{ allow: false, message }` to say why in your own words, and the action is
  refused and never counted; anything else allows it and the meter records it.

  ```ts
  createVendo({
    limits: async ({ user, action, count }) =>
      user.facts?.plan === "pro" || (await count(action, { days: 1 })) < 20,
  });
  ```

  `count` is a callback and not a number because most policies read the meter
  once, for one window, and pre-computing every window a policy might ask about
  would be a query per action per call. `window` ANDs `days`/`hours`/`minutes`
  into one lookback, or takes a `since` instant, or names a `pool`.

  **Pools** are the shared meters a user's usage ALSO counts into — a seat pool, a
  team, an org. The auth preset grows a `pools` seam beside `facts`, resolved off
  the same session decode, and its answer rides `ctx.pools` to the policy;
  `count(action, { pool: "workspace" })` then counts the whole bucket rather than
  the one person, and an allow accrues to every pool the user is in. Counting a
  pool the user is NOT in throws rather than answering `0` — a zero from a meter
  that was never resolved silently under-counts every limit written against it.

  **A denied message costs nothing.** The message choke sits at turn entry, before
  the thread is resolved, so a refused message performs no read, no write and no
  model call. The turn's whole response is the limit card.

  **A denied generation lets the turn carry on.** The generation choke wraps
  `vendo_make`, the one door an app is built through, and answers the agent with
  the same `blocked` outcome every other refusal on that registry uses — so the
  agent can say what happened in its own words — while raising the card the person
  reads on the call's own stream.

  A refusal nobody was asked about — a limit, a guard rule, an unattended park, a
  guard that could not run its check — now settles on the wire as that typed
  `blocked` outcome rather than as the ai-SDK's `output-denied`. That state is the
  terminal state of an approval a PERSON turned down: its provider conversion takes
  the refusal's words off the part's `approval`, so a refusal that has none used to
  write history that could not be sent again, and the thread died on the turn after
  one — including an unattended thread whose call is waiting on a standing grant.
  The refusal's own words are now kept in the record too, and the beat says who
  refused: "wasn't allowed", not "you declined it". A person's actual no is
  unchanged, and is the only thing `output-denied` now means.

  Both raise `data-vendo-limit`, and the chat surface renders it as a card in the
  beat's ordinary muted register: a cap reached is not a failure, so no ✕, no
  danger colour, and a polite `status` rather than an `alert`. The host's own
  sentence is what the person reads when the policy wrote one — the host set the
  cap, so only the host can say what it is or when it lifts — and a policy that
  said nothing gets the chrome's line, which claims only that the request never
  ran.

  **A policy that throws DENIES**, and logs `limits.callback_error`. A limits
  system that fails open stops limiting silently, so the host keeps believing they
  have a cap while every user is unlimited — strictly worse than a turn that was
  refused and said so.

  **A `limits` policy against a store with no usage meter is refused at
  composition.** `StoreOps.usage` is optional, and a store that cannot count reads
  every user as zero, so no limit would ever be reached and every user would be
  unlimited. It throws where the deployment is built rather than enforcing against
  counts that are all zero.

  `vendo.usage(query)` is the operator's read of the same meter — per subject and
  action, over one window — for a host's own backend job: an overage sweep, a
  usage table. A policy never uses it; a policy asks its own bound `count` and
  never names a subject. On a meterless store it refuses for the same reason
  `emit` does, because a billing sweep reading "no usage" would bill nobody.

  Unset, `limits` wires nothing: no limiter is composed, the tool registry is the
  same object it always was, and each choke point costs one `undefined` check.

- 6856b4f: The ✦ gesture collects an instruction, and mints a screen. There are no bare forks: ✦ asks what the person wants BEFORE it fires, and the fork plus that first edit are ONE operation whose output is an ordinary screen app (`app.tsx`, through the ordinary edit door) carrying the remix's provenance — component, baseline, and the instruction, verbatim.

  **Breaking, and it reaches data already on disk.** `AppSeed.instruction` is now REQUIRED (`appSeedSchema`, `@vendoai/core`). A remix seed written before this release does not have one, so its app document fails schema validation and that app will not load. There is no migration in this release. A deployment carrying remixes either backfills `seed.instruction` on those rows with the text the remix was made for, or deletes them and lets people remix again. Apps that were never remixes are untouched.

  Two doors change shape with it, both refusing a call that used to be legal:

  - `seedFrom({ component, slot?, instruction })` — `instruction` is required on `VendoClient.apps.seedFrom` (`@vendoai/ui`) and on `SeedFromInput` (`@vendoai/apps`).
  - `POST /apps/seed` (`@vendoai/vendo`) requires `instruction` in the body and answers `validation` — `instruction must be a non-empty string` — without it.

  Nothing copies the captured host source into the document any more, and nothing evaluates one: `applySeedFork`/`seededBundle` are gone from the generation engine, `seedOnto` from the seed surface, and the wire save's seeded carry-forward from `authoredDocument`. All three were internal. "Is this remix edited?" is one field read now — `doc.source["app.tsx"] !== undefined`.

  A re-seed is RE-IMAGINED rather than kept. When the host ships a new baseline, `reseed` replays the RECORDED INSTRUCTION against it instead of swapping in a pristine copy, so a remix survives its component's redesign as the thing the person asked for. Dedupe per (subject, component) is unchanged, and so is the review lane.

  Three dead ends that used to lie now tell the truth:

  - **A remix still generating is "not ready", not "broken".** Against a real model the first edit takes 9–38s; `open` answered that window with a validation failure, `useApp` spent its three retries in ~900ms, and nothing asked again — the pill sat on "Remixing…" until someone reloaded the page. A seeded app with no screen now answers the same not-found every app gives before its build lands, which the wire's existing build window turns into `{kind:"pending"}`, and `useApp` keeps asking on the embed's cadence until the screen lands or the ONE shared build deadline runs out. A genuinely tree-less app keeps its validation failure. The ✦ badge reads "Remixing…" off the open payload — the same signal the mount below waits on — so the label and the screen change together instead of the label arriving four seconds early.
  - **A fork the build gave up on says so.** A terminal `{kind:"failed"}` lands in the chrome's existing "Didn't load" state, with the server's own reason, instead of reading "Remixed" and "Sandboxed — only you see this" over a page that never got a screen.
  - **A failed remix edit never advances the baseline it did not reach.** `edit()` RETURNS `failedEdit` on its common failure path rather than throwing, and both remix doors read only the throw. A re-seed now replays BEFORE it writes the rebased `seed.baseline`, so a refused replay no longer answers 200 with the old screen and the new baseline. A failed first edit leaves the same terminal `buildFailed` marker a failed build leaves, so `open()` answers with the reason and `list()` skips the row — the next tap mints a fresh app instead of being handed the dead one forever.

- 730ac8f: Theme v2 — nineteen more brand tokens, every one optional.

  `VendoTheme` carried eight colors, two type fields, three radii and two enums.
  Everything the Kit and the chrome needed beyond that was a literal somewhere in
  our source: the green and amber the pills paint, the mono stack, the three
  shadows, the chart ramp, the border width, the chrome's own motion pair. A host
  could not reach any of them. Now it can.

  ```ts
  theme: {
    colors: { …, success: "#0a7d55", warning: "#c98a00", surfaceRaised: "#fafafa" },
    typography: { …, monoFamily: "Berkeley Mono, monospace", weightEmphasis: "650", lineHeightBody: "1.6" },
    shadow: { small: "…", medium: "…", large: "…" },
    borderWidth: "1px",
    chartPalette: ["#1d4ed8", "#0891b2", "#7c3aed"],
    motionDuration: "120ms",
    motionEasing: "cubic-bezier(.2,.8,.2,1)",
  }
  ```

  - **Every addition is OPTIONAL.** A theme file that fails to parse is discarded
    whole, so one required field would have blanked the brand of every host whose
    theme predates it. A pre-v2 theme parses and renders exactly as before.
  - **The variable NAMES stay one fixed set — 52 of them.** Three transports
    (the chrome's style object, the MCP door's `style` attribute, the MCP Apps
    shim's `:root{}`) serialize the same mapping and compare their output against
    each other, and the shim's reverse read throws on a name outside the published
    list. So `themeCssVariables` resolves each optional field against a default
    and emits every name for every theme, rather than emitting a name only for
    hosts that set it.
  - **The Kit reads them.** `success`/`warning` stop being Kit-only literals, a
    control's edge is `var(--vendo-border-width)`, and `chartSeries` reads
    `--vendo-chart-1..6` with the accent-derived OKLCH ramp — unchanged — as the
    per-entry fallback. One definition of that ramp now, shared by the emitter and
    the Kit.
  - **Three chrome tokens re-anchor onto the contract.** `--vendo-border` keeps
    the derived ~8% hairline as its DEFAULT but a host that states `colors.border`
    finally wins instead of being ignored; the `--vendo-ok`/`--vendo-warn` family
    reads `colors.success`/`colors.warning`; and `--vendo-duration`/`--vendo-ease`
    derive from the theme's motion pair (the chrome keeps its slower feel through
    a multiplier), so one host knob moves the chrome and generated views together.

  `defaultVendoTheme` is deliberately unchanged: it is the shape the MCP Apps shim
  reconstructs a theme back INTO, and a field the reader cannot recover would make
  a theme round-trip into a different theme. The fill-in values live beside it as
  `themeDefaults`, which the Kit reads for its unthemed fallbacks — so each value
  still has exactly one definition.

### Patch Changes

- 7eecc29: Four polish passes on the chat chrome's cards.

  - **An approval settles where it was asked.** The approval→notification morph is
    an AUTOMATION's ask only: a person answering their own live conversation is
    already looking at the answer, so flying the card into a corner pill narrated a
    handoff that never happened. In-thread asks carry venue `chat`, so nothing in
    the thread morphs — the venue is the rule, not a switch.
  - **The shield glyph comes off every consent surface** — the modal, the
    standing-access card, the resolved card — matching the in-chat approval card,
    which has been iconless for a while.
  - **The conversation blurs under a generated view in flight.** An opaque embed
    card travelling over a razor-sharp transcript read as two competing layers
    instead of one thing moving; the rail softens for the flight and clears as it
    lands, and stays sharp under `prefers-reduced-motion`, where a blur that cannot
    fade is just a flash.
  - **The app card arrives with the BUILD, not with the first view bytes.** It only
    mounted on the first `data-vendo-view` part, so the whole window between the
    ask and the first bytes rendered nothing build-specific. The card now arrives
    empty, in the place the view will fill, and stands down the moment the first
    partial lands.

- 2285394: Four pieces of thread polish. The transcript now follows streamed text without flicker: the stick-to-bottom scroll moved pre-paint, so the growth and the scroll that answers it land in the same frame instead of painting each burst once with the newest wrapped line below the fold, and the list carries a 26px bottom cushion under a matching scroll-edge fade so that line is never clipped and never dimmed. The follow also watches the list's actual size from the moment the list exists, not only from the thread's first render: a conversation that starts on its landing has no transcript to observe yet, and without that the first turn followed the wire's deltas alone while the paced reveal typed on between them — a live streamed turn spent about a quarter of its painted frames with the newest line below the fold. New replies is a floating centered pill above the composer rather than a full-width bar docked onto it — the bar had to square the composer's top corners to hide its seam, which read as a second permanent bar growing out of the input; the composer keeps its own shape, the pill is the single form at every width (it was already the phone and takeover clothing), and pressing it travels to the latest turn instead of teleporting. The citation snippet card portals to `document.body` like every other floating surface in the chrome: it was the last one living inside the scrolling transcript, cropped by the list's overflow and capped under its stacking context, and it now places itself against its chip's live rect — below by default, flipped above when it would run off the bottom, clamped inside either side edge — with click-to-pin, hover grace, Escape and outside-click unchanged. And a tool step in flight is a hairline ring spinner at the settled tick's size, so a step settling swaps one glyph for another without nudging its label; a step parked on the reader keeps the accent arc, and the build rail's separate pulsing pip is gone, leaving one vocabulary for "still going".
- Updated dependencies [6856b4f]
- Updated dependencies [6856b4f]
- Updated dependencies [6856b4f]
- Updated dependencies [46aee4a]
- Updated dependencies [83aec51]
- Updated dependencies [01e225c]
- Updated dependencies [d9b7c8d]
- Updated dependencies [5932631]
- Updated dependencies [491a2fa]
- Updated dependencies [6856b4f]
- Updated dependencies [6856b4f]
- Updated dependencies [37ed821]
- Updated dependencies [6856b4f]
- Updated dependencies [730ac8f]
  - @vendoai/apps@0.21.0
  - @vendoai/core@0.21.0

## 0.20.0

### Patch Changes

- Updated dependencies [095f143]
- Updated dependencies [7fcf60b]
- Updated dependencies [cfd4f48]
  - @vendoai/core@0.20.0
  - @vendoai/apps@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [2879e46]
- Updated dependencies [39a1c78]
- Updated dependencies [5f4d694]
  - @vendoai/core@0.19.0
  - @vendoai/apps@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [88ec7e6]
  - @vendoai/core@0.18.0
  - @vendoai/apps@0.18.0

## 0.17.0

### Minor Changes

- c17d492: A parked press gets its answer: the approval modal, the refresh on resolution, and the animated landing.

  A guarded action pressed on a generated screen parked for approval and then
  dead-ended twice over: the ask had no UI anywhere on the page (only a badge
  count), and once someone approved it — over the wire, from the chat card — the
  action ran server-side while the screen sat on "Sending…" and stale numbers
  forever. The resumed call's outcome was simply discarded.

  Now the whole loop closes. The apps runtime persists what became of a parked
  call (`PARKED_CALL_OUTCOME_COLLECTION`, shared with the BYO lane so both write
  the same rows), `GET /approvals/:id` serves it — answering `pending` while the
  resumed call is still running, so the decide window reads as what it is — and
  the screen watches its own parked presses: on `executed` it re-reads its query
  plan and repaints backend truth; on `declined`/`expired` it re-reads too, so a
  screen whose own state latched "sending" re-arms instead of locking forever.

  The ask itself is a centered modal, mounted wherever screens mount (slot, chat
  card, workspace stage, BYO embed, remix): the ask at hero size, Approve/Deny,
  a designed in-flight state for the seconds the decision takes to run, and a
  queue so burst presses ask one question at a time. Esc closes without deciding
  — the pending notice on the pressed control is now pressable and re-raises the
  ask. `ApprovalResolution`'s pending arm may now omit `request` (the decide
  window has no ask left to show); consumers skeleton or fall back.

  Refresh repaints animate: an arriving row opens under a fading highlight, a
  leaving row collapses and returns its gap, and numeric leaves roll to their new
  figure — repaints only, never first paint, never streams, and never under
  `prefers-reduced-motion`.

### Patch Changes

- 565caf0: The overlay launcher anchors to any viewport corner and takes host offsets. `launcher` accepts `"top-right"` / `"top-left"` alongside the bottom corners, and the object form gains `offset: { x?, y? }` — extra pixels pushed inward from the anchored corner, ridden as CSS variables folded into the existing safe-area calc so every current install stays pixel-identical. The whole launcher cluster moves as one: the first-run whisper and the completion toast follow the pill's corner (sitting below it in top corners) and inherit the same offsets. Drag is deliberately deferred; offsets cover the collision a host can predict, and `useVendoOverlay` still covers the rest.
- c8ce625: The overlay remembers conversations. A page reload resumes the conversation the user was in (the last adopted thread id persists per origin, and a transcript that ends mid-turn re-attaches to the in-flight stream), and a new previous-conversations header button — beside expand, new-conversation, and close — opens a picker listing the caller's earlier threads: select one to resume it in place, Cancel or Escape to stay. New conversation forgets the remembered id; a remembered id that no longer resolves (deleted thread, different signed-in user) self-heals to a fresh conversation through useVendoThread's existing validation, so a stale id can never strand the surface. The picker stays internal to the overlay — no new export surface — and the header icon ladder gains one slot in every pointer and takeover variant.
- 65e82e7: The in-thread automation card becomes the arming consent surface (#1090). A turn that arms an automation used to render a read-only card saying "Enabled · waiting on N permissions" while the decidable grant rows lived only on the workspace automations panel — a surface the stock overlay never mounts, and one a page navigation away in hosts whose conversation does not survive navigation, so the person could see the debt and never pay it. The card's pending asks now ride the durable approvals feed (reload-safe, never the stream) and render as the same grant-set card the panel shows, right under the automation card: every permission enumerated, one Allow settling the whole set atomically (the set id read from the automations projection at decide time), a denial disarming in the same decision, and the settled record staying in the transcript. Decisions travel the same client path as every other consent surface, so either side's decision settles the other. When the feed cannot answer, the card keeps the wire part's snapshot count — an error never reads as "nothing pending". The shared asks→rows mapping (`grantSetPermissions`) is now a public chrome export, used by the panel and the thread alike.
- Updated dependencies [c17d492]
- Updated dependencies [64004b6]
- Updated dependencies [85fc732]
- Updated dependencies [729dd3e]
- Updated dependencies [9ea21ef]
- Updated dependencies [c79866f]
- Updated dependencies [8ded5cc]
  - @vendoai/core@0.17.0
  - @vendoai/apps@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [d529cf8]
- Updated dependencies [795f8c1]
  - @vendoai/apps@0.16.0
  - @vendoai/core@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [9e0ed9a]
- Updated dependencies [b57df06]
- Updated dependencies [b324b79]
  - @vendoai/apps@0.15.0
  - @vendoai/core@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [954ad09]
  - @vendoai/core@0.14.0
  - @vendoai/apps@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [395fc1e]
- Updated dependencies [031195f]
  - @vendoai/core@0.13.0
  - @vendoai/apps@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [0d67885]
  - @vendoai/apps@0.12.0
  - @vendoai/core@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [5c8043d]
- Updated dependencies [eeebbee]
- Updated dependencies [402e7ad]
- Updated dependencies [a216b68]
- Updated dependencies [e58520e]
- Updated dependencies [863dc53]
  - @vendoai/core@0.11.0
  - @vendoai/apps@0.11.0

## 0.10.0

### Minor Changes

- e2128aa: App generation moves into one package, behind two doors

  `@vendoai/apps` now has a browser-safe **contract door** and a node-only
  **engine root**. The app format — the document, the two genui dialects and their
  compilers, the Kit, the island/jail rules, catalog + theme, the checking
  contract, remix provenance, and the wire shapes `/apps/*` returns — lives on
  `@vendoai/apps/contract`, which imports no node built-ins. The behavior that
  produces those shapes stays behind `@vendoai/apps`.

  **Migration:**

  1. **Moved `@vendoai/core` names are a hard rename** — import them from
     **`@vendoai/apps/contract`**: the genui dialect (`validateTree`, `compileWire`,
     `compilePlan`, `printWire`, the expression grammar), the Kit, the
     island/jail rules, catalog + theme, `AppFloor`/`Check`/`CheckInput`,
     `ScreenAssembler`, `MakeReceipt`, host components, and build deadlines.
     Types reaching you through `@vendoai/vendo` or the `vendoai` alias are
     **unchanged** — the umbrella re-exports the contract beside core.
     `@vendoai/apps` is ESM-only, so `require()` of these _values_ needs ESM or
     the umbrella.
     `AppDocument` and its schemas, and `Finding`, deliberately **stay in
     `@vendoai/core`** (the store contract and the harness runtime speak them);
     the contract door re-exports them, so one door serves every consumer.

  2. **Subpaths — what moved and what did not.** Entry points go 8 → 4:

     - **`@vendoai/apps`, `@vendoai/apps/e2b` and `@vendoai/apps/testing` all
       survive with their specifiers unchanged.** `./e2b` stays because the venue
       ladder reaches it as a real module seam, not merely a convenience re-export.
     - `@vendoai/apps/{sandbox-ladder,internal}` **fold into `@vendoai/apps`** —
       import those names from the root.
     - `@vendoai/apps/adapter-conformance` → **`@vendoai/apps/testing`**, not the
       root: it imports `vitest`, and the root rides every composed host's server
       path.
     - `@vendoai/apps/claude-turn` → **`@vendoai/harnesses/claude-turn`** and
       `@vendoai/apps/box-door` → **`@vendoai/harnesses/box-door`** (both moved with
       `claudeCode()`).
     - **NEW:** `@vendoai/apps/contract`.

  3. **`@vendoai/ui`, `@vendoai/store`, `@vendoai/actions` and `@vendoai/mcp` now
     depend on `@vendoai/apps`** and read the app format from
     `@vendoai/apps/contract`. Their own public surfaces are unchanged.

  **Known tradeoffs, stated plainly:**

  - **One name, still two declarations.** `@vendoai/ui` no longer keeps its own
    copy of the `/apps/*` wire shapes — it re-exports them from the contract
    door. That removes a copy; it does not yet make one definition. The engine's
    server door declares its own richer `EditResult` (with `failure`,
    `graduated`, `box`, `pendingEgress`, `automation`) beside the contract's
    four-field wire shape, so the name has two declarations inside
    `@vendoai/apps`, one per door. Unifying them decides which fields the wire
    may expose, which is a behavior change and not part of this move.
  - **Install weight.** `@vendoai/apps` declares `esbuild`, `jsdom`, `fflate` and
    `react-dom` as hard dependencies, so a browser-only consumer of
    `@vendoai/apps/contract` still installs the engine's dependency set. The
    contract door itself bundles clean for a browser target (enforced by a new
    leg in `scripts/portability-gate.mjs`); it is the install graph, not the
    bundle, that carries the weight. Pre-existing, amplified by this split.

- b0a165c: Remix is a seeded app: the pins subsystem is gone

  An app that was made from one of your components no longer carries a list of
  "pins". It carries a single `seed` — the component it started from and the
  version of that component it started at. A remix is an ordinary app that
  happens to start from something, so it is created, validated, edited and
  versioned through exactly the same doors as every other app.

  **Behaviour change you will notice: updating a remix now replaces it.**
  When the host component changes, the remix reports drift as a warning and
  nothing happens on its own. If you choose to update, you get the pristine new
  component — the edits you made to that component are replaced. The previous
  release replayed your recorded edits on top of the new version; that machinery,
  its preflight and the version trail feeding it are deleted. Drift is a warning,
  and updating is always your choice. The UI says this in the drift banner, and
  the agent tool's description tells the model to say it too.

  **Behaviour change on admission.** Every write path now runs the same document
  validation, seeded and forked apps included. Seeded bundles used to skip the
  island gate entirely, so a capture the jail could never render was accepted
  without complaint. Captures that produce invalid documents will now be refused.

  **Fixed.** A seeded app whose host component had moved on used to open with no
  imports, no sub-modules and no styles — silently. Those furnishings were
  hash-matched against the live baseline at open time, so any drift lost them.
  They now travel inside the stored component bundle. Separately, artifact export
  dropped remix provenance because the interchange field whitelist never listed
  it, so export-permission checks never ran.

  **Renames.**

  - `AppDocument.pins?: Pin[]` → `AppDocument.seed?: AppSeed`
    (`{ component, baseline, slot?, review? }`). `Pin` and `pinSchema` are removed;
    `AppSeed` and `appSeedSchema` replace them. `forkedFrom` is unchanged.
  - `AppsRuntime.pins.{fork,rebase}` → `AppsRuntime.seed.{from,reseed}`, plus
    `seed.drift`. `seed.from({ component, slot?, instruction? })` and
    `seed.reseed({ appId })` both return the `AppDocument`.
  - `pinComponentName` → `seedComponentName`; `PinBaseline`/`pinBaselineSchema` →
    `SeedBaseline`/`seedBaselineSchema`; `AppsConfig.pinBaselines` →
    `seedBaselines`; `detectPinDrift` → `seedDrift` (one seed, so it returns one
    `SeedDrift` or `null`); `ScreenPinDrift` → `ScreenSeedDrift`.
  - `EditResult.driftedPins?: PinDrift[]` → `EditResult.seedDrift?: SeedDrift`;
    the tree payload's `pinDrift` array → a single `seedDrift`.
  - HTTP: `POST /apps/fork-pin` and `POST /apps/:id/fork-pin` → `POST /apps/seed`;
    `POST /apps/:id/rebase-pin` → `POST /apps/:id/reseed`.
  - Client: `apps.forkPin(...)` → `apps.seedFrom({ component, slot?, instruction? })`;
    `apps.rebasePin(id, slot)` → `apps.reseed(id)`.
  - Agent tool `vendo_apps_rebase_pin` (appId + slot) → `vendo_apps_reseed` (appId).
  - `@vendoai/actions` no longer declares its own `CapturedPinBaseline`; the one
    shape lives on `@vendoai/apps/contract` and actions re-exports it as
    `SeedBaseline` / `seedBaselineSchema`.
  - `PinForkInput`, `PinForkResult`, `PinRebaseResult` and `PinDrift` are removed.

  Seeding into an app that already exists is gone: the gesture always mints an
  app, because a seed is the provenance of a whole app rather than a row added to
  one. The generated component name stored inside documents is deliberately
  unchanged, so apps already on disk keep working.

- 79d7088: Three shapes the apps runtime produces and the client consumes now have exactly
  one definition, in core.

  `@vendoai/ui` may not import `@vendoai/apps` (the dependency guard's layering
  rule), so it re-declared the wire shapes it reads "verbatim from the frozen
  contract text". That is a promise, not a mechanism. `pinComponentName` — the
  generated-component name a forked host slot ships under, and therefore the name
  the client's in-place mount looks the node up by — existed as THREE hand-written
  copies: `apps/pins.ts`, ui's `<Remixable>` wrapper, and ui's wire fixture.

  Moved into `@vendoai/core`:

  - `pinComponentName` → `core/app-document.ts`, beside `Pin` (it is a pure
    function of `Pin.slot`).
  - `PlacementEntry` and `ReviewStanding` → `core/app-surfaces.ts`, a new module
    whose membership rule is one line: apps produces it, ui consumes it off the
    wire.

  No package's public surface changes. `@vendoai/apps` still exports
  `pinComponentName`, `PlacementEntry` and `ReviewStanding` from the same modules
  as before, and `@vendoai/ui` still exports `PlacementEntry` and `ReviewStanding`
  from its root — each is now a re-export of core's single definition.

  `PinForkResult` was deliberately NOT unified. Its own fields match on both
  sides, but its `edit?: EditResult` does not: apps' `EditResult` carries
  `failure`, `graduated`, `box` and `pendingEgress`, which ui's copy never grew,
  and the wire returns the runtime's result untrimmed. Unifying it would widen
  `@vendoai/ui`'s published `EditResult` — a contract change, not a refactor.

- 79d7088: The per-person app-sharing chain — the Share dialog and everything under it —
  is removed. No host ever mounted the dialog; every name below was re-grepped
  across `packages/`, `examples/`, `fixtures/`, `corpus/`, `scripts/`,
  `docs-site/` and the console repo before removal, and the only callers found
  were other members of this same chain.

  **Gone from `@vendoai/ui`:** the `ShareDialog` component and `ShareDialogProps`
  (from `@vendoai/ui/chrome`), the `useAppGrants` hook, and the five client
  methods that existed only to feed them — `client.apps.grants`, `.share`,
  `.unshare`, `.promote` and `.resolvePerson`. `ForkOffer` and
  `encodeGrantPrincipal` shared the dialog's file and are unaffected; the file is
  now `chrome/fork-offer.tsx`.

  **Gone from `@vendoai/vendo`:** the wire routes `GET`/`POST`/`DELETE
/apps/:id/grants`, `POST /apps/:id/grants/resolve` and `POST /apps/:id/promote`,
  their handlers, and the `promoteApp` composition seam.

  **Gone from `@vendoai/apps`:** `AppsRuntime.promote`, and the write half of
  `AppsRuntime.access` — `list`, `grant`, `revoke` and `holder`. Their now
  unreachable supporting seams go with them: `AppsConfig.multiParty`,
  `AppsConfig.promoteApp`, and the internal `requireMultiParty` / `requireAccess`
  / `reportShare` helpers.

  **Unchanged, and deliberately so:**

  - `AppsRuntime.access.levelFor`, and `access-checks.ts`' `holds` / `owned` /
    `requireOwned` / `grantedRecords` — the permission backbone behind every app
    door.
  - The `AppAccess` seam itself (`@vendoai/store`'s `appAccess(store)`), whose
    full `levelFor`/`grant`/`revoke`/`list`/`can` surface and conformance kit are
    untouched. Grant rows are still written and read there; only the runtime door
    over that write half is gone.
  - `vendo.apps.share()` and `vendo.apps.publish()` — the Cloud snapshot and
    registry feature. A different feature that merely shares a name with the
    deleted grants `share`.
  - The auth presets' `resolvePerson` seam and `/status`'s `namesPeople` flag.
  - `@vendoai/store`'s `appStore().promote` row primitive and the hosted store's
    `lifecycle.promote` op.

- 89b4444: The `resolvePerson` auth-preset hook and the `namesPeople` status field are
  removed. Both existed for one reason — telling the Share dialog whether it could
  offer to share an app with one named person — and that dialog, with the whole
  grants chain under it, was removed in #1108. Nothing has read either since. Every
  name was re-grepped across `packages/`, `examples/`, `fixtures/`, `corpus/`,
  `docs-site/` and `scripts/` before removal.

  > **BREAKING for hosts that wired `resolvePerson`:** the hook is gone from all
  > seven auth presets (`identity`, `authJs`, `auth0`, `clerk`, `jwt`, `supabase`,
  > and the shared options type). Delete the `resolvePerson:` property from your
  > `auth:` config — it is now a type error, not a silent no-op. Nothing else about
  > your preset changes, and no behaviour you can observe changes with it: the
  > callback has had no caller since #1108.

  > **BREAKING for surfaces reading `GET /status`:** the response no longer carries
  > `namesPeople`, and `VendoStatus.namesPeople` / `useVendoStatus().namesPeople`
  > are gone from `@vendoai/ui`. The field only ever reported whether the seam
  > above was wired.

  `ResolvedPerson` is gone from `@vendoai/core` — it was the hook's return shape
  and had no other producer or consumer.

  **Untouched, and deliberately:** `auth.memberships` and `auth.facts` (the other
  preset seams), `/status`'s `memberships` field, the `Membership` type, and every
  part of `can()` / `AppAccess`. Vendo still holds no directory; the difference is
  that it no longer ships a seam nobody asks a question through.

- 0f46e44: Dead features and their public surface are gone. Every removal below had zero
  callers in this repo, the console, or the examples; nothing changed behavior for
  a caller that was using a live path.

  **`@vendoai/core` (breaking).** `AppDocument.placements` is gone from the
  interface and the schema, and the validator no longer checks it. There has been
  no writer since the placements-as-rows split; "show this app in that slot" is a
  placement ROW (`@vendoai/apps` `placements.ts`, `GET /apps/placements`), which
  is unchanged and is the live feature. Also removed: `PlanIsland` and the
  `AppPlan.island` field, because the plan-level `<Island name purpose/>`
  declaration no longer parses; and `PackSkill`, the deprecated alias for `Skill`.
  `Pin`, `pinSchema` and `AppDocument.pins` are untouched — fork provenance is
  still live.

  **`@vendoai/apps` (breaking).** `PinShipRequest`, `PinApproval`,
  `pinShipRequestSchema` and `pinApprovalSchema` never ran; `ShipDiffPin` and
  `inClientApprovalSchema` are the live path and stay. `bindingKindCheck` is gone
  — it had no callers; the `bindingKindIssues` walker it wrapped is still used by
  the validate path. The plan compiler no longer accepts a plan-level
  `<Island name purpose/>` element (an inline `<Island>` inside an app file is a
  different, live feature and is unchanged). `GenerationPromptSection["id"]`
  narrows to `"theme" | "design-rules"`; the other five ids had no producer.

  **`@vendoai/store` (breaking).** The `stateStore` and `approvalStore` helpers
  are gone. Both were test-only wrappers over the routed `records("vendo_state")`
  and approval write paths, which are unchanged and are what production uses.
  `ApprovalRow` is unaffected — it is exported from `helpers/types.ts` as before.

  **`@vendoai/agents` (breaking).** The `./harnesses` subpath export is gone.
  Import the harness factories from their own package instead:
  `import { claudeCode } from "@vendoai/harnesses/claude-code"` and
  `import { vendo } from "@vendoai/harnesses"`.

  **`@vendoai/knowledge`.** `knowledgeIndexSummary` and `parseKnowledgeConfig` are
  no longer exported from the package root. Both functions stay and are still used
  internally by `knowledgeIndexResolver`, which remains exported.

  **`@vendoai/actions`.** `DEFAULT_CAPTURE_BUDGET_BYTES` is no longer exported.
  The constant and the 256 KB default it sets are unchanged.

  **`@vendoai/ui`.** The unexported, unreferenced `TakeoverPortal` component is
  deleted.

- 384eb09: The "Add to…" picker's destinations come from a per-user slot registry on the
  server instead of `localStorage`. A slot id is host markup, so nothing knows a
  slot exists until a page renders one — but the surface that offers it as a
  destination is usually a different page, and often a different device, which
  `localStorage` could never reach.

  A mounted `VendoSlot` now reports itself through `POST /slots` (batched: a whole
  page of slots is one request, and a client repeats a slot at most once a day, so
  one long-lived tab renews its slots instead of watching them age out), and
  `GET /slots` answers the
  caller's own slots, most recently seen first. Rows age out
  30 days after the last render that reported them, so a slot deleted from the
  codebase stops being offered on its own. The rows live in the generic records
  collection (`vendo_slots`), so there is no migration to run, and `refs.subject`
  puts them in the existing erase cascade.

  > **BREAKING:** `knownSlots`, `noteSlot` and the `SlotNote` type are removed
  > from the `@vendoai/ui` and `@vendoai/vendo/react` roots, and `useKnownSlots`
  > is removed from `@vendoai/ui/chrome`. Read the registry with the new
  > `useSlots()` hook (or `client.slots.list()`); a mounted `VendoSlot` still does
  > the reporting for you, so nothing needs to call the write path by hand.

- 079d7d8: `GET /apps/:id/pin-drift` and the `client.apps.pinDrift()` method that called it
  are removed. Neither had a caller: the drift report the drift banner actually
  renders is the `pinDrift` array `open()` attaches to the payload, which is
  unchanged, as are `POST /apps/:id/rebase-pin` and the fork-pin routes.

  No rendered UI changes — the removed client method was never invoked.

- ed44a58: A dev-only workbench diagnostics channel behind `VENDO_WORKBENCH`, and the feed
  store that reads it.

  `@vendoai/harnesses` reports what a turn is doing about itself — step starts and
  ends, guarded tool calls, context and compaction, loadout, hires, errors — on a
  transient `data-vendo-debug` part. The gate is `VENDO_WORKBENCH=1` on the
  server, read once per turn: unset, no channel is registered, so nothing can
  reach the wire and nothing is ever persisted.

  `@vendoai/ui` gains the receiving half: `publishWorkbenchPart` files a chunk,
  `useWorkbenchFeed` reads the turns back in the producer's own `seq` order, and
  `developmentMode` decides whether such a surface renders at all.
  `@vendoai/vendo/react` re-exports all three, so a host on the umbrella package
  can build the pane without reaching for `@vendoai/ui` directly.

### Patch Changes

- 29c2b49: The workbench feed keeps the last 20 turns, and an update costs only the turn it
  landed in

  The store held every turn a dev session had ever seen, and rebuilt the whole
  snapshot on each part — copying every retained turn's parts array. A long
  session therefore grew without bound, and each diagnostic got slower as history
  piled up behind it.

  Turns are now capped at 20, the oldest first-seen dropped as newer ones arrive,
  and a published part replaces only its own turn's entry: every other turn keeps
  the exact object and array the previous snapshot handed out, so a reader that
  compares identities sees precisely which turn is news. Ordering, `seq` sorting,
  and the fresh outer snapshot per part are unchanged.

- Updated dependencies [e2128aa]
- Updated dependencies [e1032f9]
- Updated dependencies [079d7d8]
- Updated dependencies [0e51585]
- Updated dependencies [e87a765]
- Updated dependencies [8105ade]
- Updated dependencies [361f9b9]
- Updated dependencies [b0a165c]
- Updated dependencies [1549f90]
- Updated dependencies [591ea46]
- Updated dependencies [e87a765]
- Updated dependencies [79d7088]
- Updated dependencies [79d7088]
- Updated dependencies [89b4444]
- Updated dependencies [0f46e44]
- Updated dependencies [70644e3]
- Updated dependencies [d9ae728]
- Updated dependencies [61b75bd]
- Updated dependencies [384eb09]
  - @vendoai/core@0.10.0
  - @vendoai/apps@0.10.0

## 0.9.0

### Patch Changes

- 7207bb6: Three pieces of chrome copy no longer name a place the host may not have. The morph toast's fallback subtitle read "Runs as you · recorded in Activity", the approval-required toast hinted "recorded in Activity", and a recurring Slack post was described as "It runs as you, and you can pause it anytime" — all three point at an Activity or automations surface that `@vendoai/ui` ships but cannot know the host mounted. A host that mounts neither (the Maple demo mounts neither) was promising, in its own voice, something it could not honour. Each line now keeps only what is true on every host: the morph toast falls back to the bare "Runs as you" that `venueByline` already uses, the toast hint says what approving means ("Runs as you once approved") instead of where it goes, and the Slack automation sentence ends after "It runs as you." No host is made wrong by the new wording, and none of it invents a destination.
- 7207bb6: Two connects started at once now get two sign-in windows instead of fighting over one. Every connect surface opened its window under the same fixed name, and a window name is precisely what makes `window.open` hand back a window that is already open — so the second connect inherited the first's window, replaced a sign-in page that was still mid-flow, and then had that window closed underneath it by whichever connect finished first. The window is now named after the same per-row key the surface already keys its connect state by, so concurrent connects — which the connected-accounts panel and the connect tray both allow by design — stay independent from the click through to the broker's consent page.
- Updated dependencies [18c77cd]
  - @vendoai/core@0.9.0

## 0.8.1

### Patch Changes

- 1e27609: The connected-accounts panel's own two connects work again. `Reconnect` on a broken row and the connect-ahead chips called the shared `completeConnection` with no sign-in window, which left it opening one _after_ the initiate await — the post-await shape Safari, Firefox and any Chromium with a popup blocker refuse by call-stack provenance, so the buttons did nothing at all when clicked. Both now open the window synchronously inside the click, as `ConnectCard` always has. And a window the browser refuses anyway is no longer a dead end on any connect surface: the panel and the connect tray both offer the broker's sign-in URL as a plain link while the poll keeps running, so finishing it in a tab still settles the account. Previously a refused window left a spinner and, two minutes later, "nothing changed" — with nothing the person could do about it.
- 1ad9c74: Two real defects in the tree renderer, and one dead extension point removed.

  - The node error boundary cleared its own latched error on every re-render
    while a payload was streaming, so a node that kept throwing re-rendered
    itself until React's nested-update guard crashed the whole surface the
    boundary exists to contain. It now retries only when an input actually
    changes — a new prefix, a new node, or the flip to the final payload.
  - The jail's zod shim answered `then` with another chainable node, which made
    every schema (and the module object itself) a thenable whose callback never
    fires: one `await` inside a generated component hung the island forever.
    `then` is absent now, and `in` agrees. Only `then` — it is the whole thenable
    protocol, and `.catch(fallback)` is a real zod method the shim still answers.
  - `registerTreeRenderer` is removed from `@vendoai/ui/tree`. The payload
    renderer registry served exactly one format and had no caller anywhere;
    `PayloadView` checks the format tag directly. `InClientVenue` and `PinDrift`
    are no longer re-exported from the tree subpath — import them from
    `@vendoai/ui`, which is where they are declared.

- f411174: A refused disconnect in the connected-accounts panel says what to do about it.

  `ConnectedAccountsPanel` caught the wire's refusal and threw the reason away, so every
  failed disconnect read the same: "it is still connected. Try again in a moment." The panel
  reads the code now, and that retry sentence is reserved for the faults that actually clear
  on their own (broker 5xx, timeouts, a dropped request):

  - `blocked` → "Sign in first, then disconnect Gmail."
  - `forbidden` → "You don't have access to disconnect Gmail here."
  - `not-implemented` / `cloud-required` → "Disconnecting Gmail isn't set up here — there's
    nothing you can do from this screen."
  - `not-found` → **not an error at all.** The broker answers not-found for any id outside
    the caller's own scope, so the account is already gone and the person's intent is a fact.

  The wire's own message still never reaches the person.

  A severed row also stops depending on the list read that follows it. `useResource` keeps
  its last good page when a refresh fails, so a 503 on that read used to put the row straight
  back wearing a Connected chip, with nothing said — a disconnect that looked like a button
  doing nothing. That was true of every successful sever, not just the already-gone case.
  The panel now drops the row on the wire's word — and never permanently: a list read the
  server actually answers that still carries the account overrules the sever and brings the
  row back, since `not-found` also covers a missing _connector_ rather than a missing account
  and the client cannot tell those apart. A failed read still changes nothing.

- b99147f: Connect asks first: a `request_connection` tool and a connect card that owns the whole answer.

  The agent can now ASK for a connection instead of spending a call it already knows
  will be refused. `request_connection` (toolkit + one plain sentence) mints exactly the
  `connect-required` outcome a refused service call produces, so the card the user sees
  is the same card — nothing new on the wire. The tool is projected only where the
  deployment can actually connect the toolkit, and refuses one it cannot rather than
  raising a button that can never succeed.

  The card itself now opens its sign-in window _inside the click_, before any `await`:
  Safari and Firefox judge a popup by call-stack provenance, and the old order (initiate,
  then open) is precisely the shape they block. The window opens centered and blank, is
  navigated when the redirect URL arrives, and is closed from the opener once the account
  goes active. A window the browser blocked anyway is no longer a dead end — the same
  poll keeps running behind an "Open sign-in in a new tab" link.

  The card also says what connecting grants, in plain words rather than OAuth scope
  strings, and offers "Not now" — which leaves a one-line Skipped record that still
  re-offers Connect, and tells the agent so it can adapt.

- 022f789: The automations adoption handoff is removed. When an automation's sponsorship
  lapsed — the sponsor left, lost their permissions, or somebody else edited the
  app — the automation stopped and an "adoption card" waited inside the app so the
  next editor could take it on, re-approving its reads and writes as themselves.
  No host used it.

  Sponsorship itself is unchanged: an automation still runs as a named person, and
  still stops when that person's authority lapses. What goes is the second half —
  the handoff to somebody new.

  Gone: `AutomationsEngine.adoption()` and `.adopt()`, the `AdoptionCard` and
  `AdoptionNeed` types (`@vendoai/automations`); `ADOPTION_VENUE_KEY`
  (`@vendoai/core`); `POST /automations/:id/adopt/:triggerId` (`@vendoai/vendo`);
  `client.automations.adopt()`, `<AdoptionCard>`, `<AdoptionVenueCard>`,
  `ADOPTION_VENUE_KEY`, `AdoptionCardProps`, `AdoptionVenue` and `AdoptResult`
  (`@vendoai/ui`).

  Pre-1.0 hard cut, no deprecation shim. A stopped automation is restarted the way
  it was armed in the first place: anyone who can edit the app calls `enable()`
  again, which re-approves its reads and writes under the new sponsor. The stopped
  sentence the run row and the list carry now says "anyone who can edit this app
  can turn it back on" instead of "…can take it on".

- d3e7dcd: The voice stage is removed. `@vendoai/ui` shipped a live WebRTC voice surface —
  an animated presence orb, a rolling caption ticker, a transcript drawer, a
  consent bar that accepted a spoken "approve", and a `vendo_act` bridge that ran
  a real guarded agent turn mid-call. Nothing mounted it: the demo host un-docked
  `<VendoStage />` on 2026-07-30, and no example, fixture, or docs host has
  rendered it since.

  Gone from `@vendoai/ui`: the `@vendoai/ui/voice` entry point in its entirety
  (`realtimeVoiceDriver`, `createVoiceActBridge`, `VoiceDriver`,
  `VoiceDriverEvent`, `VoiceDriverHandlers`, `VoiceSessionHandle`,
  `VoiceSessionView`, `RealtimeVoiceDriverOptions`, `VoiceActBridgeOptions`),
  `useVoice` and `UseVoiceResult` from the root entry, `<VendoStage />` from
  `@vendoai/ui/chrome`, and the `voice` prop on `VendoProvider`. Gone from
  `@vendoai/vendo`: the `useVoice` / `UseVoiceResult` re-exports on
  `@vendoai/vendo/react`.

  Pre-1.0 hard cut, no deprecation shim. Nothing else changes: the thread
  composer keeps its optional `onVoice` callback, so a host that wants a mic
  button still gets one and wires it to its own surface.

- 354f231: Remove undo and rollback entirely.

  **BREAKING, despite the patch version.** This release ships as a patch off the
  0.8 line (pre-1.0 convention), so the version number does NOT signal the removal
  below. If you call any export in the lists that follow, this release breaks your
  build — read them before upgrading. A `0.8.x` range accepts this version, so the
  version number alone will not hold it back.

  Two separate features, both cut: rolling an app back to a previous version, and
  walking a workspace file back to the version before its newest commit. **Users
  lose the ability to roll an app back.** That is deliberate. Pre-1.0, so this is
  a hard cut with no deprecation shim.

  Version history LISTING stays, everywhere: the app's capped 50-entry version log
  and the workspace's per-path revision trail are unchanged, and so is everything
  built on the recorded history — the review venue's newest-approved-version serve
  (`review.serveDocFor`), the pin-rebase replay trail (`history.pinIntents`), and
  the edit journal's append/discard/prune.

  Removed from `@vendoai/apps`:

  - `AppsRuntime.history(appId, ctx).undo()` — the surface now returns
    `{ list(): Promise<VersionEntry[]> }` only
  - `AppHistoryAccess.surface(appId).undo()` (the `createAppHistory` internal)

  Removed from `@vendoai/core`:

  - `StoreOps.workspace.undo(target, opts)`
  - `storeWireWorkspaceUndoRequestSchema`
  - the `"workspace.undo"` key from `STORE_WIRE_PATHS`, so the store wire is
    **31 doors, not 32** — `StoreWireStatus.ops` is now `31`, and the workspace
    family is 4 (index · read · commit · history)
  - the `workspace.undo` cases from the `storeOpsConformance` suite, and the
    `undo` implementation from `memoryStoreOps`

  Removed from `@vendoai/store`:

  - `workspaceStore(store).undo(caller, path)`
  - `WorkspaceRows.undo` and the `UndoOutcome` type (internal — never exported
    from the package index)
  - `createStoreOps(store).workspace.undo`, with its `pathsMovedOn`,
    `newestCommitTouching` and `commitCreated` helpers and the `created` array
    the commit ledger wrote for them
  - the `recordHistory` option on the internal write path, whose only `false`
    caller was undo — every landed write now records its superseded revision

  Removed from `@vendoai/ui`:

  - `VendoClient["apps"].undo(id)`
  - `useApp().history.undo()` — the hook's `history` is now `{ list() }`

  Removed from `@vendoai/vendo`:

  - the `POST /apps/:id/history` route (the `{ op: "undo" }` body). `GET
/apps/:id/history` is unchanged; the path now serves GET only
  - the `workspace.undo` leg of the hosted (Cloud) store adapter, which called
    the console's `POST /workspace/undo`

  **Existing data is left exactly where it is — no migration, no cleanup.**
  Existing `vendo_workspace_history` rows and `vendo:app-history:*` records stay
  readable by listing, but the content they hold becomes unrestorable: nothing
  reads it now. Those rows self-trim at `WORKSPACE_HISTORY_LIMIT` per path, except
  for a deleted path that is never written again, which holds its blob forever.
  That is a real consequence of removing the feature, and it is not repaired here.

- c41de74: The code-land runtime folds into `@vendoai/ui/kit`. `@vendoai/kit` is gone: its
  seven modules — the provider, the guarded query/action hooks, the `$state`
  binding, and the reshape + aggregate vocabulary — now ship from the `./kit`
  subpath they already re-exported, so a generated app loads one bundle instead of
  two and the `$state` store has one owner rather than a wrapper around one.

  Pre-1.0 hard cut, no alias package. Change `@vendoai/kit` imports to
  `@vendoai/ui/kit`; every export name is unchanged.

- fed58ab: Three promises the chrome was not keeping.

  - `theme.motion: "reduced"` is now honoured by the pin ceremony and the morph
    toast, not just the OS media query. The pin flight reads `data-vendo-motion`
    off the chrome boundary the card sits in — the stylesheet rule that kills
    animations inside a reduced-motion root could never have stopped it, because
    the flight is a Web Animations animation. The morph toast folds the same
    setting into the flag that picks its timings and its exit, so it stops writing
    "reduced" onto the DOM while running the full travel budget and docking.
  - A new approval is brought into view even when the transcript re-renders inside
    the 80ms before the scroll. The scroll target lives in a ref now: previously
    the approval was marked "seen" up front and one re-render in that window
    cancelled the scroll permanently rather than deferring it — and a settling
    stream re-renders several times right when an approval arrives, so consent that
    landed below a tall generated view was never scrolled to.
  - A polled collection hook skips its read while the document is hidden, and
    re-reads the moment the tab comes back. A workspace left open in a background
    tab was spending a request every few seconds for a view nobody could see; the
    shared approvals feed has followed this rule since ENG-219 and now every
    resource does.

- 13e2452: An app's `$state` no longer leaks into the next app rendered in its place. `TreeView` keyed its stateful body on `tree.root`, but the compiler roots every compiled app at the same synthetic `root` node, so the key never changed between two different apps: React reused the instance and app B rendered app A's `$state` (and outcomes). `TreeView`, `PayloadView` and `AppFrame` now take an optional `appId` — the identity the surrounding code already had — and key on it. Omit it and the key falls back to `tree.root` exactly as before, so no existing caller changes behavior.
- b99147f: One component family: the legacy prewired set is retired, and the Kit is the
  only built-in vocabulary.

  Vendo shipped two component families that shadowed each other by name. The
  legacy prewired/branded set (`packages/ui/src/tree/{primitives,branded}.tsx`)
  won every name collision, so the Kit's `Stat` could never format a value, its
  `Text` was masked by a permissive one, and `DataTable`'s smart table sat behind
  a plain `Table`. That set is gone. One family now, declared once by
  `KIT_SPECS`, taught by `kitPrompt()`, resolved by the compiler, rendered by
  `KIT_COMPONENTS`, and validated from the same schemas.

  **Breaking — `@vendoai/ui/tree`.** These exports are removed: `Stack`, `Row`,
  `Grid`, `Text`, `Skeleton`, `Surface`, `Divider`, `Card`, `Button`, `Input`,
  `Select`, `Table`, `Badge`, `Stat`, `Tabs`, `PREWIRED_COMPONENTS`,
  `BRANDED_COMPONENTS`, and their prop types. Import the components from
  `@vendoai/ui/kit` instead — every name above except `Table` and `Skeleton`
  exists there with theme-token styling and real prop schemas.

  - **`Table` → `DataTable`.** The Kit table sorts, filters, searches,
    paginates, resolves dot-path column keys, and formats each cell. Its
    `columns` take `{key, label?, format?, align?}` objects rather than bare
    strings, `rows` is required, and `emptyLabel`/`rowKey` are `emptyState` and
    automatic respectively.
  - **`Skeleton` is no longer a component.** A loading placeholder is renderer
    chrome, not something a tree names, so it moved inside
    `tree/forming-skeleton.tsx` and off the public surface. It marks itself with
    `data-skeleton` (it was `data-primitive="Skeleton"`).
  - **`Tabs` keeps its tree contract.** The Kit `Tabs` now accepts the wire
    shape — string or `{value,label}` items, an initial `value`, and panels as
    CHILDREN in tab order — alongside its code-only `{label, content}` items.
    Tabbed apps are unaffected.
  - **`data-primitive` is gone.** Every built-in marks itself with `data-kit`;
    tests and styles selecting on `data-primitive` must be retargeted.

  **Reserved names now follow the Kit.** `RESERVED_COMPONENT_NAMES`,
  `BRANDED_COMPONENT_NAMES`, and `PREWIRED_COMPONENT_NAMES` are removed from
  `@vendoai/core`; `KIT_COMPONENT_NAMES` and `KIT_WIRE_COMPONENT_NAMES` replace
  them, so a generated component may not shadow any Kit name.

  Two schemas were widened where the retired family had been quietly absorbing
  real usage: `Text.text` takes `string | number` (matching its `ReactNode`
  implementation), and a single-segment `$state` read binds into any prop again
  while `state.key.deeper` stays a compile error.

  Stored apps naming `Table` or `Skeleton` render the contained
  "Unknown component" notice on that node while every sibling still renders.

- 7f35f23: Starting one connect in the connect tray no longer makes every other connector inert. The tray tracked the connect in flight as a single toolkit for the whole surface and disabled every add button off it, so on a host with a full catalog the first click froze all 55 remaining connectors for the length of the 120s poll — with no cancel, and no disabled styling anywhere to say why, so the tray looked interactive and simply ignored every click. Connect state is now keyed per row, the way `ConnectedAccountsPanel` already keyed it: several connects can run at once, each row keeps its own spinner, its own failure reason and its own "your browser blocked the sign-in window" link, and no add button disables at all — the row that is connecting shows its progress dots instead of a button, so there is nothing left to grey out.
- b99147f: One theme→CSS-variable mapping, owned by `@vendoai/core`.

  The same `VendoTheme` was flattened into `--vendo-*` custom properties in three
  places — the ui chrome, the MCP door's connect/consent pages, and the MCP Apps
  shim's `:root{}` block — each a hand-kept copy of the others, and they had
  drifted: the door emitted 16 of the 32 variables the chrome does, so a themed
  MCP page never saw `--vendo-color-scheme`, `--vendo-base-size`, the density
  sizing scale, or the motion timings. `defaultVendoTheme`, `resolveTheme`,
  `colorSchemeForBackground` and `themeCssVariables` now live in
  `@vendoai/core` (and are exported from it); `@vendoai/ui` re-exports them
  unchanged, and both MCP paths are a one-line serialization of the same call.
  `VENDO_THEME_VARIABLE_NAMES` is read off that mapping, so the generation
  prompt's brand-token line and the shim's reverse read cannot fall behind a
  rename.

  Two brand bugs fell out of the merge. The Kit's token fallbacks had `surface`
  and `background` swapped, so an unthemed Kit painted a white page with
  off-white cards inverted; its `fontFamily` fallback had also lost the Onest
  brand stack. Both now derive from `defaultVendoTheme` instead of being retyped.

  The phantom `--vendo-space-*` variables are gone. Nothing ever emitted them, so
  every reference rendered its fallback; the door pages, the Kit's `Stack`/`Row`
  gap, and the tree's notice and open-in-product card now use the real
  `--vendo-density-*` variables where the scale matches, and the literal
  elsewhere. Rendered output is unchanged.

- f260c10: Two surfaces that answered a click by doing nothing, silently.

  - The connect tray's cancel latch was only ever SET, by an unmount cleanup, so
    React's dev StrictMode remount latched it for the tray's whole life: every
    connect exited its status poll on the first check, which means the row sat on
    "Connecting…" forever with no error and no end while the person finished
    signing in elsewhere. The mount effect clears the latch now, the way
    `ConnectCard` and `ConnectedAccountsPanel` already did.
  - The automations panel's run-health strip discarded its own `/runs` response
    whenever its effect restarted — which is every refresh, since a refresh is a
    new `automations` array. The restarted effect had already skipped the row as
    "fetched", and the discarded response then unmarked it, so no retry was ever
    issued. With the poll on, the run sweep covered for this a tick later; with
    the cadence off (`pollMs={0}`, a host driving its own refreshes) the strip
    was simply gone for the session. The fetch is row-keyed and lands
    idempotently, so it is no longer cancelled at all.
  - The same panel's `/runs` reads now carry a per-row generation, compared before
    the write. Several reads of one row are in flight whenever `/runs` is slower
    than the cadence (the sweep fires on a timer without waiting for its previous
    tick), and the row used to believe whichever answered last rather than
    whichever was asked last — so a slow answer overwrote a fresh one and the
    health strip went backwards on screen: a run the person had just watched
    succeed reverted to Failed until the next tick.

- 7288546: Two surfaces that stated something untrue, and were believed.

  - `DataTable` compared every filter against the RAW field while its cells show
    the formatted value. Picking "paid" from a filter dropdown also listed the
    "unpaid" rows (each column carried `filterFn: "includesString"`, and a
    dropdown is an exact-value control); searching for "$2,500" or "Mar 14" — the
    text on screen — matched nothing; and the dropdown offered "2026-03-14" as an
    option for a column reading "Mar 14, 2026". One helper, `displayText`, is now
    what the options, the dropdown match (exact) and the search all compare
    against. Sorting still keys off the raw value.
  - The Share dialog never read the `error` its own hook exposes, so a failed
    app-access read rendered the empty initial data as fact — twice, and
    self-contradicting: "You don’t have access to this app." next to "Nobody else
    yet — it’s just you." It now says it cannot confirm who the app is shared with,
    offers a retry, and withholds every control a level authorises — including
    after a later read fails, where the dialog used to keep the previous owner
    level and go on offering the picker, Share and each row's Remove on the
    strength of an answer it no longer had. The grant rows themselves stay: a
    failure to read is not evidence that access was revoked.

- 2357b22: The setup surface: declared URLs, one join law, a VendoProvider-only surface, and `init` = install + the shared sync flow.

  **Breaking: `VendoRoot` is removed. Use `VendoProvider`.**

  ```diff
  -import { VendoRoot } from "@vendoai/vendo/react";
  -<VendoRoot components={registry}>{children}</VendoRoot>
  +import { VendoProvider } from "@vendoai/vendo/react";
  +<VendoProvider baseUrl="/api/vendo" components={registry}>{children}</VendoProvider>
  ```

  That is the whole migration: the props are identical, and `baseUrl` is the wire
  mount with your deployment's path prefix included (default `/api/vendo`).
  `npx vendo doctor` names the swap and the file if you miss one (`E-WIRE-010`).

  **Breaking: `VENDO_BASE_URL` is the app's FULL public URL, path prefix included.**

  Set it to `https://site.com/maple`, not `https://site.com`. Nothing strips its path
  any more: host tool calls, login redirects and box callbacks all hang off it, each
  attaching the prefix exactly once through one helper in `@vendoai/core`. Two new
  optional overrides: `VENDO_HOST_API_URL` (the host API on another origin) and
  `VENDO_LOGIN_URL` (the login page, which may be on another domain).

  Stored tool paths in `.vendo/tools.json` are now **prefix-free** — run `vendo sync`
  once to regenerate them. This closes #866 (login redirect drops the base path),
  #867 (returnTo double-prefix) and #914 (host tools 404 under a path prefix). When the
  client and the server disagree about where the wire is mounted, the browser now gets
  one loud named error instead of a mysterious 404, and `vendo doctor` catches an
  OpenAPI server mount that disagrees with `VENDO_BASE_URL` (`E-CFG-003`).

  **`vendo init` no longer generates `vendo/registry.tsx` or `vendo/vendo-root.tsx`.**

  It scaffolds the server route handler and prints one paste: `<VendoProvider>` around
  your client root. If you have host components, you write one small `"use client"`
  file yourself — see the quickstart. Existing generated files are untouched; they are
  yours now.

  **`vendo init` ends in the same flow `vendo sync` runs.** One extraction, one theme
  path, one consent question, one report — `init` in full mode (a fresh install has
  judged nothing), `sync` incremental. `init` now reads `.env` as well as `.env.local`,
  so a model key that lives in `.env` is no longer invisible.

- bd4248d: `VendoPage` is removed

  The full-page workspace surface is cut. Two public exports go with it:

  - `VendoPage` (component)
  - `VendoPageProps` (type)

  Nothing else is removed. `AutomationsPanel`, `ActivityPanel` and
  `ConnectedAccountsPanel` — the three panels `VendoPage` used to mount behind
  its tabs — stay exported and are individually mountable, and `WaitingQueue`,
  `VendoOverlay`, `VendoThread`, `VendoPalette` and `VendoSlot` are untouched.

  **If you rendered `<VendoPage />`,** mount the panels you actually want
  instead. Each carries its own theme and stylesheet, so a `VendoProvider`
  ancestor is the only requirement:

  ```tsx
  <VendoProvider client={client}>
    <div style={{ maxWidth: 780, margin: "0 auto" }}>
      <AutomationsPanel />
      <ConnectedAccountsPanel />
      <ActivityPanel />
    </div>
  </VendoProvider>
  ```

  Keep them in a ~780px container. `VendoPage` used to cap their measure and the
  activity ledger rows stretch badly at full bleed.

  The `surface="page"` mode of `VendoEmbed` and the `.fl-page*`, `.fl-center*`
  and `.fl-rail*` chrome CSS are removed along with it.

  One behaviour change outside the page: the pin ceremony now skips its flight
  animation when the page has no landing target (no host slot and no Apps
  shelf). Pinning still works; it just does not animate. Previously the ghost
  lifted and then vanished mid-air, because the Apps shelf it aimed at only ever
  existed inside `VendoPage`.

- 65de3c6: Remove five options and one recorder that nothing in the repo could reach: the
  director stream recorder in `useVendoThread` (its two globals were never set by
  anything), `subscribeConversationCommands`, `MorphToast`'s `dockTo` and
  `holdMs` props, `VendoSlot`'s `emptyState.mark` and `emptyState.layout` props,
  and `isConsumerSafe`. The thread surface's comments no longer ship internal
  ticket, lane and ruling labels into ejected customer code.
- Updated dependencies [a7a0fcf]
- Updated dependencies [e092567]
- Updated dependencies [b99147f]
- Updated dependencies [46923cc]
- Updated dependencies [b50a766]
- Updated dependencies [022f789]
- Updated dependencies [354f231]
- Updated dependencies [ee92750]
- Updated dependencies [d599d23]
- Updated dependencies [89660d1]
- Updated dependencies [2b6d60f]
- Updated dependencies [b99147f]
- Updated dependencies [b99147f]
- Updated dependencies [2357b22]
  - @vendoai/core@0.8.1

## 0.8.0

### Minor Changes

- 963d980: Agents can address a place on the page, and a slot tells the truth about what is in it.

  An agent could make a person a screen, but never say WHERE it goes: a host wired
  exactly one destination and everything landed there. Now a slot is something the
  agent can name, the person can choose, and the page can be honest about.

  **Placement is a row, not a string on the app document.** "Show this app in that
  slot" moves off `doc.placements` — which is never read any more — and into real
  rows in the generic collections: a pointer at `plc:<subject>:<slot>` naming who
  holds the slot under which token (the single compare-and-swap arbitration
  point), and a live row at `plcv:<subject>:<slot>:<token>` that exists only while
  that placement holds it. That buys three things a document scan could not: a
  slot can show a build that has not landed yet, a slot resolves in one query
  instead of listing every app the person owns, and one app per slot is enforced
  by the write instead of by whoever read last.

  - `apps.place({ app, slot })` / `apps.unplace(…)` / `apps.placements({ slots })`
    on the runtime, `POST /apps/:id/place`, `POST /apps/:id/unplace` and
    `GET /apps/placements?slots=…` on the wire, `client.apps.place/unplace/
placements` on the client.
  - `place()` is one decision, not read-then-write: it compare-and-swaps on the
    pointer's revision, the loser retries against the winner's row, and the
    displaced app comes back as `evicted` so the surface can say what moved.
  - `unplace()` and "clear this slot" only ever delete the token they named, so a
    stale client can never evict the app that replaced it. Tokens are never
    reused.
  - Rows carry `refs.app_id`, and deleting an app sweeps them BY APP — so deleting
    an app you share can no longer leave a permanent "didn't build" card standing
    over somebody else's host markup.
  - `GET /apps/placements` gates every entry on the same viewer check
    `open`/`get`/`list` use; a slot the caller may no longer view reads as empty.
    Slot ids are normalized identically on read and write, and percent-encoded per
    item in the query, so an id containing a "," survives the round trip.
  - `useSlotApp(slot)` now answers `{ appId, status }`, over ONE poller per client
    shared by every mounted slot (it no longer takes `pollMs`).

  **`vendo_make` takes one optional `slot`,** honoured on both engines the one
  front door routes to. The slot is claimed at MINT — the instant the app id
  exists, before a single token is generated — so the place the caller aimed at
  shows the build forming instead of staying empty until it lands, and shows the
  failure if it never does. An ask no engine landed writes the same terminal
  tombstone a failed build writes, so a claimed slot turns into the honest failure
  card the moment either engine gives up. A placement whose app no longer exists
  renders as nothing placed, never a stuck failure card. On a CHANGE, `slot` is
  refused by name: silently moving an existing app would evict whatever holds that
  slot off the back of an edit nobody aimed there.

  **Two new tools do the moving.** `vendo_apps_pin { app, slot }` puts an app the
  user already has into a slot and reports what it replaced as `evicted`;
  `vendo_apps_unpin { app, slot }` takes it out and leaves the app itself alone.
  Both aim by the app's id OR the name the user said, and both are graded `write`
  — a placement row is small and reversible.

  Neither is offered to an unattended run, and neither is executable in one.
  `PRESENCE_ONLY_TOOLS` (core) joins THE LAW's projection, and the guard's choke
  point refuses a presence-only call outright — so a standing automation grant
  that reaches `execute()` by name, without listing, can no longer rearrange a
  page with nobody watching. Keyed on the name, not the grade, so policy rules and
  consent cards still read an honest `write`. A slot-bearing `vendo_make` in an
  unattended run still RUNS and simply drops the slot: placement is what needs a
  person present, creation is not, and refusing the call would silently break the
  automations that legitimately build screens.

  **`McpDoorConfig.withholdTools`** names tools one door never offers, checked
  BEFORE the `vendo_` prefix bypass and on BOTH legs of a mount — a turn-bearing
  session used to be able to list and call a name the deployment said it never
  offers. Curation, not security: a withheld name answers with the same in-band
  not-found an unknown name gets.

  **`VendoSlot` reads the placement's build status, not just its app id:**

  - **building** — an EMPTY slot shows the skeleton it already uses, minus the
    invitation, because there is nothing left to ask for. A slot carrying the
    host's own markup KEEPS it until the build is ready: a working host component
    never blanks into a skeleton for the length of a build.
  - **failed** — the consumer sentence (never the wire's `reason`, which names
    components and env vars and is written for whoever can fix the build), a "Try
    again" that re-issues the ORIGINAL request when the failed record kept one,
    and "Clear this slot". The failed card DOES replace the host's own children,
    deliberately: a build that will never land should not hide behind markup that
    looks fine.
  - **ready** — unchanged, and now proven in a browser for both surface kinds.

  **`AddToPicker` puts "Add to…" on a generated view's bar,** so a person can send
  it to any slot the host has mounted instead of the one place a host wired. It
  awaits `client.apps.place` before saying "Added to Hero", then announces the
  placement so a mounted slot fills without waiting out its poll. It appears in
  both places a generated view has a bar — the app embed and the IN-THREAD card,
  which is the surface a person actually reaches a view from in every host that
  renders its conversation through `VendoOverlay`. The affordance stays a
  one-click "Pin to dashboard" while the origin knows a single destination — a
  menu of one is not a choice — and becomes the picker the moment it knows more.

  - `noteSlot` / `knownSlots` (new, re-exported from `vendoai/react`): the picker's
    destinations. A slot id is the host's markup and no Vendo record carries it, so
    a mounted `VendoSlot` recording itself in origin-scoped `localStorage` is the
    only way a surface on another page can offer that slot at all. A slot the host
    filled with an explicit `appId`/`pin` stays out of the list — a placement
    written into it would never be read.

  **Pinning is Vendo's write now:** with `pinSlot` set, the pin affordance calls
  `apps.place` itself. `onPin` remains as an optional side-effect seam, so a host
  no longer needs a pin route of its own (Maple's is deleted).

- 4b6e362: The agentic UI redesign: visible work, one card system, the ChatGPT-shaped center.

  Every consent, connect, grant-set, adoption and voice surface now renders
  through one card shell, so geometry lives in a single place and the cards
  differ only in contents. The transcript shows the agent's work as quiet human
  beats instead of lifecycle strings, and the center is a rail with New chat and
  two named doors over a pure home.

  Behaviour hosts may notice:

  - **`colors.border` is no longer read by the chrome.** The hairline is derived
    as ~8% of the foreground so the edge sits the same distance from text in any
    brand and in both colour schemes. A host that tuned `colors.border` to change
    Vendo's hairline will see no effect. `radius.small` and `radius.large` are
    now read (previously only `radius.medium` drove the sheet).
  - **A consent card's plain-words line comes from the RISK GRADE**, never from
    the tool's name. Host-authored `ToolMeta.description` still wins, and a
    sentence synthesized from the real inputs still outranks the class line. A
    tool nobody graded reads as ungraded, keeps its ceremony, and never folds its
    inputs behind a disclosure.
  - **Descriptor text never reaches an end user.** A tool descriptor's
    `description` is authored for the model; the card reads host `ToolMeta`
    instead, and falls back to copy Vendo wrote.
  - One shared approvals feed replaces three independent pollers (measured 39 →
    13 requests per 60s across three surfaces).
  - The mobile takeover inerts the host behind it rather than covering it, and no
    longer mints a second `<main>` landmark.

- 21c8b10: One brain, one scheduler, and consent that is per trigger — everywhere outside
  `@vendoai/automations` that has to agree with it.

  A fire-time call now carries WHICH trigger fired (`TriggerRef.id`) and WHICH
  firing it belongs to (`TriggerRef.lineageId`), so the guard matches an away grant
  on (app, trigger) instead of app-wide — arming one trigger no longer authorizes
  its siblings — and keys effect receipts on the firing, so re-running a run that
  failed loudly cannot repeat the work the first attempt already completed. The
  store carries that dimension too: grant and run rows index the trigger, so an
  adapter that trusts its own refs narrows exactly as far as the engine does
  instead of handing back a sibling trigger's grant. An agentic firing runs through
  the same away runner the rest of Vendo uses, seeing only the connector dispatcher
  it was actually granted. A machine app's `vendo.json` schedules are folded into
  its document triggers when the manifest syncs, so there is exactly one scheduler
  in the deployment (the automations engine) and one tick that drives it. The panel
  and the wire follow: per-trigger enable, disable, dry-run and adopt doors, a
  `POST /runs/:runId/rerun` door, and a run that stopped for a missing permission
  showing "Failed" with the consent card and Grant & re-run right on the row.

- ab5d181: Add `@vendoai/kit`, the runtime a generated app imports inside its box.

  A code-land app now has the same vocabulary a `.vendo` screen has, reaching the
  same implementations rather than parallel ones:

  - `reshape.{pick,rename,asPoints,format,sum,min,max,count}` — the eight LIVE
    reshape ops, each one call to core's `applyReshape`. The two deprecated ops
    (`asOptions`, `template`) are deliberately not wrapped, and `avg` retired with
    the pipe (#808) — code-land averages through the `average` aggregate below.
  - `sum`, `count`, `average`, `min`, `max`, `difference`, `daysUntil`, `groupBy` —
    the aggregates, evaluated by core's `evaluateExpr`. `sum(rows, "amount_cents")`
    runs the code path `sum(invoices.amount_cents)` runs; the seam is asserted
    against `evaluateExpr` directly, so a second implementation cannot appear
    without a test going red.
  - `useToolQuery` / `useToolAction` — the guarded read and write over the door
    that already exists, `POST /apps/:appId/call`, through the same
    `createVendoClient` the host's chrome uses. A non-ok outcome contributes no
    data and sets `dataUnavailable`, so a failed load never reads as "you have
    nothing"; a successful action refreshes the screen's queries.
  - `useVendoState` — the `$state` binding for code.
  - `<VendoAppProvider>` — the one provider, which derives the app id and wire base
    from the URL the wire serves the app at (`<base>/apps/:appId/serve/`), so a
    same-origin call rides the viewer's own session.

  `@vendoai/ui` gains two things this needed: the keyed `$state` store is now
  `useKeyedState` in `@vendoai/ui/kit`, shared by the tree renderer and code-land
  (one implementation, two venues, exactly as `fmt` is), and the wire client is
  reachable at `@vendoai/ui/client` so the shim calls the door through the existing
  client instead of a second fetch layer.

- 8d623ec: Connector discovery uses the broker's own search; execution stays ours.

  `search_connectors` searched a local keyword index and then EXPANDED a matching
  toolkit server-side, expecting the client to re-list via
  `notifications/tools/list_changed`. Measured live, Claude Code's agent SDK
  registers no list-changed handler for an HTTP MCP server — exactly one
  `tools/list` per session — so a tool the model had just found was uncallable for
  the rest of that session. The shape is one the industry has abandoned (GitHub
  removed `--dynamic-toolsets`; Composio, whose catalog this is, never shipped it).

  Three permanent tools replace it, so the listing never changes and callability
  never depends on a re-list. They are ordinary registry tools, so they work on
  both the `vendo()` and `claudeCode()` harness paths:

  - **`find_service_tools(need)`** — the connector's OWN search. Each match
    carries the callable slug, the full input schema, the caller's connection
    status and the broker's next-step message, inline, so the model can construct
    a call with no second lookup. A match the broker has no schema for says so
    rather than inviting a guess. The answer is bounded by its own SERIALIZED
    size, under the turn's `agent.toolOutputCap`, so it can never be the result
    that cap truncates: broker schemas are kilobytes each (Composio's run 5–7KB),
    and a result cut at a character count loses a schema mid-object with nothing
    saying which match lost it. Matches are included whole, in the broker's
    relevance order, until the budget is spent; whatever is left over is reported
    as `moreMatches` (a count) and `moreMatchesNote` (narrow the `need` and search
    again), never dropped silently. A single schema larger than the whole budget
    still returns its row, with the same `schemaUnavailable` marker that already
    sends the model to ask rather than guess.
  - **`use_service_tool(slug, arguments)`** — looks up the broker's per-tool risk
    tag, maps it to a `RiskLabel`, lets the guard decide run/ask/refuse, executes,
    and lands on the audit trail with its toolkit named — the same guarded path a
    `host_*` call travels. An untagged tool is `ungraded` (ask-by-default); risk is
    never inferred from a tool's name.
  - **`list_connections`** — unchanged, re-backed by the connector's connection API.

  The Composio adapter also trims the documentation Composio ships for PEOPLE
  inside the machine schema — `examples`, `human_parameter_name`,
  `human_parameter_description` — before a schema reaches the model. It is a third
  of the bytes and none of it is needed to construct a call (measured against
  their live catalog 2026-08-03: eight email matches, 36,407 chars whole, 24,736
  trimmed), so trimming is what lets a realistic search come back complete instead
  of short. Only KEYWORDS are removed: a parameter named `examples` is an
  argument, and survives.

  Both new tools exist only when a connector adapter can actually serve them
  ("no adapter, no tool"): `find_service_tools` and `use_service_tool` need a
  connector implementing the new capabilities, `list_connections` needs only a
  configured connector.

  **The Composio adapter's tool plane now speaks one API version, so a tool the
  search finds is a tool that runs.** Discovery is Composio's tool-router, which
  exists only at `v3.1`; execution and the `apps`-scoped listing were still on
  `v3`. Those are two different catalogs, not two doors onto one — so the model
  would find a slug and the executor would answer `Tool <SLUG> not found`, an
  opaque connector error rather than a connect card or a hint to search again.
  Live-measured against their catalog 2026-08-03, 19 of the 42 slugs a `v3.1`
  search returned for eight ordinary needs did not exist on `v3` at all: every
  Outlook mail and calendar action (`OUTLOOK_SEND_EMAIL`, `OUTLOOK_CREATE_DRAFT`,
  `OUTLOOK_SEND_DRAFT`, `OUTLOOK_CALENDAR_CREATE_EVENT`), every `COMPOSIO_SEARCH_*`,
  five `TEXT_TO_PDF_*`, `GOOGLECALENDAR_EVENTS_GET` and
  `WEATHERMAP_GEOCODE_LOCATION`. It only stayed hidden because Gmail and Slack
  happen to exist in both. Connector tools that used to fail now run.

  The skew ran the other way too, so the listing moved with the executor: `v3`
  carries legacy names `v3.1` has renamed (`OUTLOOK_OUTLOOK_CREATE_DRAFT`,
  `COMPOSIO_SEARCH_NEWS_SEARCH`), and a `v3` listing feeding a `v3.1` executor
  breaks identically. An `apps`-scoped host therefore sees the larger, current
  `v3.1` catalog — Gmail goes from 23 tools to 63, Outlook from 43 to 305 — and
  more of those tools arrive `ungraded`, which is ask-by-default.

  Connected accounts and auth configs stay on `v3` deliberately: live-verified
  identical on both versions, and that plane has no catalog to skew against.
  Both versions are named in one constant each at the top of the adapter.

  **Removed public surface.** All of it existed to serve lazy expansion:

  - `@vendoai/core`: `ToolListingContext.listingScope` and
    `ToolRegistry.releaseListingScope`. A listing no longer has to be identified —
    every tool a run may call is on every listing that run is given.
  - `@vendoai/actions`: `Connector.discoveryIndex`, `Connector.expandToolkits`,
    the `ToolkitIndexEntry` type, `ActionsRegistry.expandToolkits`, the `ctx`
    parameter of `ActionsRegistry.search`/`loadoutSeed`, and
    `ToolSearchOptions.maxExpansions`. `ActionsRegistry.loadoutSeed` now answers
    with every loaded tool and ignores its `connectedToolkits` argument: the
    argument only ever filtered lazily expanded connector tools, and there are
    none. New in their place, all optional:
    `Connector.searchTools`, `Connector.toolRisk`, `Connector.executeSlug`, and the
    `ServiceToolMatch` type. `Connector.toolkitOf` is unchanged — the pre-guard
    connect check still rides it.
  - `@vendoai/agent`: `CONNECTOR_DISCOVERY_TOOLS` now names the three tools above;
    the discovery registry's ports changed shape with them.
  - `@vendoai/mcp`: the door no longer advertises `tools.listChanged`, no longer
    diffs its listing around a call, and no longer keeps a per-session
    notification-replay flag.
  - `@vendoai/vendo`: the `maxSearchExpansions` handler option.

  **Known gap, deliberately not papered over.** A connector that cannot search
  gets neither new tool, and the zero-key Vendo Cloud connector has no search
  backend today — so a Cloud-default deployment that does not scope
  `connectorApps` reaches connectors through the connect dock only until the
  console broker exposes a search endpoint. Filling that with keyword scoring or
  name-based risk inference is exactly what this change removes.

  **Automations can run connector tools, through the consent they already use.**
  `use_service_tool` is one tool name standing in for the broker's whole catalog,
  so its descriptor cannot carry a real grade — it is `ungraded`, and design §12
  withholds `ungraded` from an unattended run the same way it withholds
  `destructive`. Left there, arming an automation on a connector would have been a
  narrowing: before this wave an individually-graded `read` connector tool WAS
  offered to an automation.

  The fix reuses declare-then-accrete consent rather than inventing a mechanism.
  An automation's steps declare the service actions they will call; the person
  arming it approves those specific actions, in the enable card they already see;
  the unattended run may then call exactly those slugs.

  - **`@vendoai/core`**: `GrantScope` gains a third member,
    `{ kind: "service-tool", slug }` — the missing middle between "this whole
    tool" (twenty thousand actions on this one name) and "this exact payload"
    (useless on the next run). Plus `USE_SERVICE_TOOL`, `serviceToolSlug`,
    `serviceToolPhrase`, `withResolvedRisk`, and `RiskResolver` (moved here from
    `@vendoai/guard`, which re-exports it unchanged).
  - **`@vendoai/guard`**: a `service-tool` grant matches a call by its slug.
    `tool` and `exact` grants are untouched, and nothing attended mints the new
    scope, so chat behaviour is unchanged.
  - **`@vendoai/automations`**: `AutomationsConfig.resolveRisk` — the SAME
    resolver the composition gives the guard. Arm-time capture grades a declared
    connector call with it, so the consent card states the grade the call will
    really run under and the grant it mints carries the descriptor hash the guard
    recomputes at fire time. Capture is per service action, and its consent
    sentence names the action in a person's words ("Allow "Morning digest" to
    fetch emails in Gmail while you're away").
  - **`@vendoai/ui`**: a consent row for a connector permission reads as its
    service action with the service's own logo, instead of "Use an outside
    service" once per row.

  What did NOT change: §12 still withholds the dispatcher from every unattended
  listing, and a granted service action the broker grades `destructive` is still
  refused away — the same answer a granted `host_*` send has always got.

  **Second known limit.** An agentic automation declares no slug, so it captures
  no connector grant at arm time: its connector calls park at fire time and
  accrete a per-slug grant when a person approves them. The alternative would have
  been a tool-wide grant on the dispatcher, which is the whole catalog behind one
  card.

- 6224a7e: An embedded app reports its height and the frame fits it — inside the host's
  bounds, never outside them.

  `HttpFrame` — the embedded served app — had no resize protocol at all. It sat at
  a fixed `min-height: var(--vendo-app-frame-height, 320px)`, so a served app was
  either padded with dead space or clipped, whichever way its real content fell.
  The jail frame next door has had a working protocol the whole time. There are now
  exactly ONE of them, shared:

  - `tree/frame-resize.ts` owns the identity gate (`event.source ===
iframe.contentWindow` — the one thing a sender cannot forge), the message
    validation, and the clamp. Both `JailedComponent` and `HttpFrame` call it, and
    the jail's private `MAX_JAIL_HEIGHT` and inline resize handler are gone. A
    security gate with two copies is a gate with two chances to be wrong.
  - The wire is unchanged, deliberately: the framed document posts
    `{ vendo: true, kind: "resize", height }` to its parent, exactly as the jail
    runtime already does. Nothing renamed, no field added.

  **The host's bounds win.** The host sized the slot when it embedded Vendo; that
  is a constraint the app lives inside, never overrides. The app _reports_ its
  natural height, and the frame fits that report between the host's floor and
  ceiling — an app taller than the ceiling scrolls inside its own frame instead of
  pushing the host's page around. Both bounds are plain CSS on the frame, so a host
  states them where it already styles Vendo and in whatever unit it likes:

  - floor: `--vendo-app-frame-height` (served apps, default 320px) and
    `--vendo-jail-min-height` (generated components, default 16px) — both already
    existed and both mean the same thing they did before.
  - ceiling: `--vendo-app-frame-max-height`, new, defaulting to `8192px` — the
    jail's old hard limit to the pixel, so a host that configures nothing gets
    exactly today's behaviour.

  No new React props: a host that never touches this sees no new API.

  **Breaking, small:** `AppFrameKeepalive.reopen` is removed. A woken machine used
  to mint a fresh ingress URL, so the frame had to notice the wake and re-open for
  the new address — and to notice it, it listened to four global activity events,
  tracked an activity flag, and read `document.activeElement` as a stand-in for
  activity it could not see inside a cross-origin frame. Served-app URLs are stable
  proxy URLs now: a wake is invisible to the frame, the address never changes, and
  there is nothing to recover. The `ping` leg is untouched and still keeps an
  on-screen embed's machine awake. Callers passing `{ ping, reopen }` drop
  `reopen`; nothing else changes.

- 6eb8a04: **BREAKING:** the knowledge entailment verifier is removed. The knowledge
  stack is a pure retrieval plug-in again, and `weakScoreThreshold` is once more
  the sole refusal calibration — unchanged, and still the knob to tune.

  The check shipped off by default and the live measurement is why it never got
  turned on: over the 94-question corpus it still answered 7-10 of 34
  unanswerable questions per pass, while costing a model call per search and
  seconds of latency on a call the user waits through. It never cleared the bar
  it existed for, so it is gone rather than left as a knob nobody should set.

  Removed surface:

  - `@vendoai/knowledge`: `entailmentVerifier`, `KNOWLEDGE_VERIFY_TIMEOUT_MS`,
    `KNOWLEDGE_VERIFY_TURN_BUDGET_MS`, the `KnowledgeVerifier` /
    `KnowledgeVerdict` / `KnowledgeVerifierInput` / `KnowledgeVerifierPassage` /
    `KnowledgeVerifyOptions` / `EntailmentVerifierOptions` types, and the
    `verifier` + `verifyTurnBudgetMs` options on `createKnowledgeTools`. The tool
    reverts to its pre-verifier decision rule: chat search → one deep retry on
    weak evidence → structured `insufficient-evidence`.
  - `@vendoai/core`: the `verifier` model seat (`Seat`, `SEATS`,
    `ResolvedModels`, `migrateModelSeats`) and the `unverified` field on the
    `data-vendo-citations` stream part.
  - `@vendoai/vendo`: the `VENDO_KNOWLEDGE_VERIFY` and
    `VENDO_MODEL_KNOWLEDGE_VERIFIER` environment knobs, and the
    `models.verifier` / `models.knowledgeVerifier` slots.
  - `@vendoai/ui`: the amber "I couldn't check this answer against the
    documentation" line. The engine-outage flag and the structured
    searched-line are untouched.

- fbf265b: One front door: `vendo_make` replaces `vendo_apps_create` and `vendo_apps_edit`,
  and it hands back words instead of the app.

  **Breaking.** `vendo_apps_create` and `vendo_apps_edit` no longer exist. In their
  place is one tool with three parameters:

  ```ts
  {
    request: string,   // the ask, in the calling agent's own words — required
    app?: string,      // an existing AppId, to change that one specifically
    context?: string,  // free-text background, for callers whose conversation we cannot see
  }
  ```

  Two tools meant every calling agent — ours, a host's own AI SDK or Mastra agent,
  an outside agent over MCP — had to decide "new or change?" before it could ask,
  and get it right. That was never their decision: the seam knows whether an app
  exists, and a caller that wants a specific one says so with `app`. `context`
  exists because an outside agent's transcript is not ours to read; on our own
  doors the runtime's transcript stays authoritative and `context` is supplemental.

  **Also breaking: the tool returns a receipt, not the document.**

  ```ts
  interface MakeReceipt {
    id: AppId;
    title: string;
    status: "ready" | "building" | "failed";
    say: string; // ONE speakable line, consumer voice
  }
  ```

  The old tools returned the entire `AppDocument` — the tree, the island sources,
  the storage declarations, the machine reference. So a model was handed UI and
  trusted not to describe it, retell it, or invent from it. A model handed a tree
  eventually talks about the tree. Screens go server → slot; the agent only ever
  gets words, and `say` is the line it can utter verbatim. `status: "building"` is
  the honest answer while work continues.

  Two things follow from the receipt, and both are improvements rather than
  compromises. The automation card is now PUBLISHED by the apps runtime through the
  existing view-stream seam instead of being reconstructed at the agent bridge out
  of the edit tool's return value — one less part read by shape (01-core §16's own
  anti-smuggling rule, which that reconstruction was the exception to). And
  `instant()` now speaks the receipt's `say` rather than a canned "Updated.",
  which fixes a real mis-speak: a rejected change comes back OK, so the canned line
  claimed success for work that did not happen.

  **Migrating.** If you call the tool by name from your own agent, rename it and
  rename `prompt` → `request` and `appId` → `app`; drop `instruction` into
  `request`. If you read fields off its result, read `id` and `title` off the
  receipt and say `say`. If you had a policy rule or an override matching
  `vendo_apps_create` / `vendo_apps_edit` / `vendo_apps_*` for the build tools,
  match `vendo_make` — it deliberately sits OUTSIDE the `vendo_apps_` prefix,
  because it is the front door rather than a member of the runtime's family. Core
  exports `isVendoAppsTool(name)` for anything that needs to recognise both.

  Everything else about the call is unchanged: risk grade `read` (actions inside
  the screen are still graded and consented individually at call time), the view
  channel, the build-failed banner, and the transcript's build card.

- d0c3cc9: Risk grading stops guessing from tool names, and a tool nobody has graded now
  says so out loud instead of running.

  **The word lists are gone.** Extraction used to read a tool's name against
  `DESTRUCTIVE_WORDS` / `READ_WORDS` (and Composio slug verbs) to pick a grade.
  English is infinite, so that list was guaranteed to miss — _pay, charge,
  refund, approve, merge, publish_ were never on it — and its existence is what
  stopped anyone from auditing the labels. No code path concludes anything from
  a tool's name anymore.

  **Only facts grade a tool**, in priority order: a human (`overrides.json`), the
  AI judge (which reads the handler source and quotes its evidence), then
  protocol facts that are true by definition — HTTP `DELETE` is `destructive`, a
  declared GraphQL/tRPC `mutation` is at least `write`, and Composio's own
  `destructiveHint`/`readOnlyHint` say what they say. A `GET` is **not** a fact
  about reading (GETs that mutate exist) and a `POST` is not a fact about
  writing (search endpoints post).

  **⚠️ Breaking behavior: an unjudged catalog now asks on mutations.** Anything
  nothing above graded is the new first-class `ungraded` risk state, and the
  guard's default treatment is to ask — like `destructive`, and at the guard
  level rather than as an init-written rule, so a hand-wired server with no
  policy config at all gets it too. On an install that never ran the AI judge
  this is a real change: tools that used to run silently now park on an approval.
  That is the point — `payInvoice` classified `write` and ran un-gated. Three
  ways forward, and every one of them is a sentence:

  - run `vendo sync` with a model key so the judge grades the catalog;
  - grade the tools you care about by hand in `.vendo/overrides.json`;
  - or decide, in writing, that you accept them:
    `{ "match": { "risk": "ungraded" }, "action": "run" }`.

  `vendo doctor` reports the count plainly (`catalog: 34/61 tools ungraded`,
  code `E-TOOLS-003`), and a keyless `vendo init`/`vendo sync` says what the
  consequence is instead of implying the grades are real.

  **`critical` is now `confirmEach`.** Behavior is unchanged — checked before
  rules, grants, and the judge; none of them can suppress it; every call earns
  its own input-bound, single-use approval. The old name read as a severity rung
  and it is not one: the grade is a _fact_ about the action (a payment is a
  `write`), while `confirmEach` is _governance_ — who must be present. They are
  orthogonal, which is why a data export can be `read` + `confirmEach` and a bulk
  archive can be `destructive` without it. Host-authored files
  (`overrides.json`, `judgments.json`, `.vendo/tools.json`) accept `critical:` as
  a read alias indefinitely; every writer emits `confirmEach`. In TypeScript,
  `ToolDescriptor.critical` becomes `ToolDescriptor.confirmEach` and
  `decidedBy: "critical"` becomes `decidedBy: "confirmEach"`.

  **A standing denial means a person said no.** An ask that re-issues the same
  call id is answered by the user's earlier no instead of minting a new card — but
  only when a _human_ wrote it: an abandoned chat turn, a timed-out embed, and the
  TTL sweep reap the pending row and let the next issue ask again. A person's no
  also voids any unconsumed yes still sitting on the same call, and a decision can
  be taken back with `guard.approvals.revoke(id, principal)` / `DELETE
/approvals/:id` (the mirror of `grants.revoke`). Taking a decision back and
  replaying an approval are the same one-time transition, so a call can never both
  run and be voided — a take-back that arrives after the call was already
  authorized answers `conflict` rather than reporting success. `Guard` grows one
  optional method for the block that spends a yes WITHOUT replaying its call
  (automations arms a standing grant from it): `spendApproval(id, principal)`
  contends on that same transition and answers `spent` / `already-spent` /
  `taken-back`. Custom Guards are unaffected — callers feature-detect it, exactly
  like `abandonApprovals`.

  Three known limits, all written down at the code that carries them. The receipt
  is the only atomic step: an approval ROW has no guarded write (the store offers
  `atomic` for threads, apps and generic rows only), so every marker on it is a
  read followed by a write and something can move the row in between. Because the
  transition winner is settled before any row write, the worst that costs you is a
  stale marker — never an execution, since the transition a call would need is
  already spent. And a custom `Guard` that does not implement the optional
  `spendApproval` puts the automations grant mint back on that read-then-write
  footing, where a revoke landing in the window can lose to the mint; the guard
  that ships here has the seam. Third: when an automation's parked run resumes, its
  standing grant is written just before the call and taken back if the call is not
  authorized after all — every outcome the process lives through, a thrown one
  included, but a hard kill in between leaves that grant behind and nothing sweeps
  it. It shows up in `grants.list`, pinned to the tool's `descriptorHash`,
  app-bound and away-only, and you can revoke it.

  One consequence worth knowing: `descriptorHash` follows the field rename, so
  approvals and grants persisted before the upgrade no longer match their tool's
  new hash. They lapse into a re-ask, which is the fail-closed direction.

- 98eba22: A streaming turn never goes silent, and a turn whose client vanished can be
  rejoined.

  **SSE keepalive.** A turn's first byte waits on a provider call and a slow tool
  streams nothing for its whole duration, so the wire could sit quiet long enough
  for a proxy or a browser to drop the connection. Every turn response now leads
  with an SSE comment frame and gets one per 15s of silence. `@vendoai/core` gains
  `withSseKeepalive`, `startSseKeepalive`, `SSE_KEEPALIVE_FRAME` and
  `DEFAULT_SSE_KEEPALIVE_INTERVAL_MS`; both engines' responses use it, and the
  `vendo try` dev server's own copy is gone.

  Hosts may notice: **the SSE body now contains comment frames.** They are ignored
  by the SSE grammar, so `useChat`, `DefaultChatTransport` and any spec-compliant
  parser see an unchanged message sequence — but a hand-rolled reader that assumes
  every frame starts with `data: ` needs to skip lines beginning with `:`. This is
  not a new event: there is no new `HarnessEvent` member and no new
  `data-vendo-*` part.

  **Stream resume.** The client half already shipped in `ai@6`
  (`ChatTransport.reconnectToStream`, which `useChat().resumeStream()` calls) and
  had no server to talk to, so a reload mid-turn painted the user's question and
  nothing else. The wire gains `GET /threads/:id/stream` — the SDK's own URL,
  method and 204 contract — serving the turn from the start of the stream and then
  following it live. Recording is per-turn, in memory, byte-capped, and dropped 30s
  after the turn settles; the persisted transcript remains the durable record.

  `useVendoThread` now resumes automatically after it loads a thread's transcript,
  and returns `resumeStream()` for surfaces that reconnect on their own.

- a004031: **BREAKING:** the data hooks no longer return a generic `data` alias.

  `useApps`, `useThreads`, `useActivity`, `useApprovals`, `useConnections`,
  `useGrants`, `useAutomations` and `useApp` each returned the same value twice —
  under the named field the contract makes canonical (`apps`, `threads`,
  `events`, `pending`, `connections`, `grants`, `automations`, `app`) and again
  as `data`. The alias is removed; read the named field. `error`, `isLoading`,
  `refresh` and every write callback are unchanged.

  ```diff
  - const { data } = useApprovals();
  + const { pending } = useApprovals();
  ```

- a0dbfc6: The agent can now be told who the user is and what they are looking at.

  Two seams, both optional, both merged into one `[Situation]` block on every
  message the user sends:

  - **User facts.** The `user` resolver on the `authJs()` and `jwt()` auth presets
    may now return a `facts` object alongside the principal, and those facts reach
    the prompt. The session is decoded once per request for both the principal and
    the facts. An anonymous request resolves no facts.
  - **Live screen context.** `useVendoContext(data)` publishes structured host data
    for as long as the component is mounted, and retires it on unmount. Several
    mounted callers coexist and merge. `VendoProvider` also takes `captureScreen`
    (default `true`) to control the screen snapshot that rides the same channel.

  **BREAKING (`@vendoai/ui`, `@vendoai/vendo/react`): `useVendoContext` is now
  `useVendoProvider`.** The name `useVendoContext` previously belonged to the
  zero-argument hook that read everything `VendoProvider` supplies; it now belongs
  to the host-facing hook above, which takes data and returns nothing. Both names
  still exist, so the compiler is the thing that catches this:

  ```diff
  - const { client } = useVendoContext();
  + const { client } = useVendoProvider();
  ```

  Because both names still exist, the compiler catches this rather than the
  runtime: an existing zero-argument call now fails with `TS2554: Expected 1
arguments, but got 0`. Rename the call and you are done — nothing else about the
  provider value changed.

### Patch Changes

- ab5d181: `@vendoai/ui/kit` now exports the embedded-surface runtime and the theme
  helpers a Vendo app needs inside its own box: `startFrameProtocol`,
  `applyThemeVars`, `postToHost`, and `themeCssVariables` / `resolveTheme` /
  `defaultVendoTheme`.

  The inner half of the frame resize protocol moves out of the jail runtime into
  `embedded-runtime.ts` so the jail and a box-served app share ONE implementation
  rather than two hand-maintained copies. Behaviour is unchanged, including the
  measured viewport-block normalization that keeps a `100vh` child from ratcheting
  an auto-sized frame to its cap.

- 4515c7f: The jail's `script-src` actually binds, so a sandboxed component cannot phone
  home.

  The generated-component jail carried `script-src 'nonce-<N>' 'unsafe-eval'`, and
  the nonce was the hole. CSP blanks a nonce's content attribute but not its IDL
  property, so code running inside the jail — which is the untrusted code — could
  read the jail's own nonce off a script element and stamp it on a `<script src>`
  of its own. Browser-verified against the shipped policy: the request completed,
  foreign code executed in the jail, and the data in its URL left the browser. A
  nonce in `script-src` also makes `'unsafe-inline'` be ignored, so the directive's
  source list — deliberately empty — never governed anything.

  The policy is now `script-src 'unsafe-inline' 'unsafe-eval'`. Nothing about the
  jail is relaxed: `'unsafe-inline'` only permits inline script, which this
  document is entirely made of and which `'unsafe-eval'` already allowed the realm
  to produce, and with no nonce present the empty source list is finally the thing
  that decides. A component can no longer load a script from any origin, so the
  residual exfiltration risk — a shared or remixed component sending the data it
  was handed somewhere — is closed. `default-src 'none'`, `connect-src 'none'`,
  the opaque origin, and the `allow-scripts`-only sandbox are unchanged.

  Hosts are unaffected: an `about:srcdoc` frame also inherits the embedder's
  policy, and the jail boots (or does not) under exactly the same host policies as
  before.

- 1deaa5c: A persisted turn failure reads whole after a reload.

  The failure's headline rendered through the build beat's label — `white-space:
nowrap` + `text-overflow: ellipsis` — inside a block capped at `max-width: 92%`
  of a turn that is itself shrink-to-fit. The percentage therefore resolved
  against a width the block's own text had just set, so the box came out narrower
  than the headline it contained and the ellipsis ate the end: a reloaded failure
  with no detail line under it read "The response didn't f…" (144px of a 159px
  sentence). The turn already caps at 92% of the list, so the inner cap is gone
  and a failure headline now wraps instead of clipping — it is content, not a
  progress line. No copy, color or component changed.

- Updated dependencies [2e792a1]
- Updated dependencies [963d980]
- Updated dependencies [3f98372]
- Updated dependencies [21c8b10]
- Updated dependencies [1bb535b]
- Updated dependencies [8d623ec]
- Updated dependencies [a004031]
- Updated dependencies [2722d81]
- Updated dependencies [f884bfe]
- Updated dependencies [a5293af]
- Updated dependencies [b022eb3]
- Updated dependencies [c9df3f7]
- Updated dependencies [6eb8a04]
- Updated dependencies [fbf265b]
- Updated dependencies [2ed91b0]
- Updated dependencies [e6aaa7a]
- Updated dependencies [d0c3cc9]
- Updated dependencies [798b618]
- Updated dependencies [10a2b44]
- Updated dependencies [98eba22]
- Updated dependencies [f7c6da2]
- Updated dependencies [14e8246]
- Updated dependencies [fbf265b]
- Updated dependencies [38a840d]
  - @vendoai/core@0.8.0

## 0.7.0

### Minor Changes

- ea3cb0b: A pin now has a payoff. Pinning a generated view used to be silent: the panel
  stayed open over the page, and the slot showed the app whenever its next ≤5s
  poll happened to fire — nothing connected the click to the result.

  Every pin affordance (the in-thread card bar and the workspace stage) now runs
  one sequence, graduated from the Keystone demo:

  1. the panel dismisses first, because the payoff is on the page and the card
     being pinned sits in a modal over a scrim;
  2. a ghost of the card flies into the slot (300ms) and the slot takes a settle
     pulse (180ms) — 480ms total, deterministic, and the slot is scrolled into
     view first so the landing is actually watchable;
  3. the slot re-reads on the pin event instead of waiting for the poll tick.

  `prefers-reduced-motion` keeps the dismiss and the pulse and skips the flight.
  The ceremony is presentation only — the pin is still whatever the host's
  `onPin` writes — so a slot that is not mounted means no animation rather than a
  stranded ghost.

  New public surface, all optional:

  - `usePinAction()` (`@vendoai/ui/chrome`) — what the built-in affordances call.
  - `playPinCeremony({ appId, slot, dismiss })` — the same sequence for a host
    running a pin from its own control.
  - `announcePin(appId)` / `onPinAnnounced(listener)` (`@vendoai/ui`) — the bus
    `useSlotApp` listens on, for hosts that pin outside a Vendo surface.
  - `pinSlot` on `VendoRoot`/`VendoProvider` — the ceremony's destination. Only
    needed by hosts mounting several slots; with one, the ceremony finds it.

- 37ec12a: New `Remixable` chrome component: wrap any host element to mark it remixable.
  At rest a small muted ✦ sits in the element's top-right corner; hovering (or
  tabbing into) the element blooms it in place into a **✦ Remix** pill, held open
  for a 200ms grace so the cursor can travel to it. Clicking opens the
  conversation surface EMPTY with the element attached — a `Remixing · <name>`
  chip in the panel chrome that rides with the next message and clears on send —
  so the pill can never fire a turn on its own. Under `prefers-reduced-motion`
  the bloom snaps.

  ```tsx
  <Remixable name="Rent Roll">
    <RentRollTable units={units} />
  </Remixable>
  ```

  `name` is the surface in the host's own words (the chip's label, and what the
  agent is told); the optional `context` is one grounding line appended after the
  user's message, exactly like `VendoTrigger`'s. Hosts wiring their own element
  call `openVendoConversation({ remix: { name, context } })` — the same registry
  seam, now carrying an attachment alongside a prompt.

  Distinct from `VendoSlot`'s `remix` flag, which forks the component pinned in
  that slot; `Remixable` attaches any element to the next ask and forks nothing.

- 8f5a7c0: A failed turn now carries its own error, so the thread never shows a blank
  reply.

  When a turn's stream errored, the only trace on the wire was the ai-SDK `error`
  chunk. That chunk belongs to no message: it sets `useChat`'s transient `error`
  and nothing else. The turn itself persisted as an assistant message with **zero
  parts**, so the moment the thread was re-read — a reload, a thread switch,
  `VendoPage` refetching after the mint — the explanation was gone and the user's
  question sat there answered by a blank bubble. On a keyless install that
  blank bubble was the whole first experience: the server logged `Vendo found no
model key…`, the panel showed nothing durable.

  The agent now writes the same gated string (`wireErrorMessage` — Vendo's own
  crafted text or the fixed generic line, never provider internals) into the turn
  as a `data-vendo-turn-error` part beside the error chunk. It persists with the
  turn, and the thread renders it inline where the reply would have been, in the
  failed-beat vocabulary a failed app build already uses. The live banner keeps
  its Retry but drops its detail line while the turn is already saying it, so the
  same sentence is never printed twice.

  Additive to the wire (§15 forward-compat): consumers that don't recognize the
  part ignore it.

### Patch Changes

- dd73974: Three fixes the Keystone demo build turned up.

  **ConnectCard hangs on "Connecting…" under React StrictMode.** The card's
  cancel ref was only ever SET (by the effect's cleanup) and never reset on
  setup, so dev-mode's mount → cleanup → re-mount latched it before the user
  ever clicked: `completeConnection`'s poll loop saw "cancelled" on its first
  check, returned without throwing, and the card sat on the spinner forever.
  It now resets on setup, exactly like its sibling `ConnectedAccountsPanel`
  already did. Hosts no longer need `reactStrictMode: false` to demo a connect.

  **The composer centred its own text past one line.** `.fl-composer-row` was
  `align-items: flex-end`, which is right for a one-line field and wrong for
  every other: a textarea's text sits at ITS top, so as the field grew the row
  pushed the icons and Send DOWN while the text stayed put — the input read as
  mis-centred and Send moved under the cursor mid-sentence. The row is now
  top-anchored, so the field grows downward and the controls hold still. At one
  line the icon's 34px box and the text's 33px line box agree, so the collapsed
  composer is unchanged.

  **A single failed `apps.open` skeletoned a pinned app forever.** `useApp`
  recorded the error and every mounted surface kept rendering "Loading app…"
  until a full page reload. The load now retries three times with backoff
  (300ms, 600ms), and a load that really is dead renders a terminal state with
  a "Try again" button — in `VendoSlot` and in `VendoPage`'s app pane.

- Updated dependencies [8f5a7c0]
  - @vendoai/core@0.7.0

## 0.6.1

### Patch Changes

- @vendoai/core@0.6.1

## 0.6.0

### Minor Changes

- a7199db: Chrome polish wave + the automation card's missing emitter.

  - **Status ribbon docks onto the composer** (Codex-style): narrower than the
    composer, top corners only, its bottom edge tucked behind the card — no more
    floating pill with a gap, on both the page surface and the overlay's
    dock-anchor DOM.
  - **Approval card de-escalated**: the ceremony card keeps the neutral surface
    with a single amber accent bar instead of the full yellow wash; the
    ALL-CAPS "CRITICAL" eyebrow is gone; risk slugs render in the user's
    language ("Irreversible", "Makes changes", "Read-only") with the raw slug
    intact on `data-risk` and the tooltip.
  - **App-card dot stands down when ready**: the pulsing build dot fades and
    collapses once the view is generated; the ready bar carries just the name.
  - **`.fl-btn` is a non-wrapping flex row**: icon + label ride one line (the
    connect card's "Connecting…" spinner no longer folds onto its own line).
  - **`VendoPage` accepts `thread`** (`suggestions` + `discoverability`
    passthrough to the chat tab), so hosts can move their curated landing onto
    the full workspace; Maple's Ask Maple page and Cadence's assistant now
    render the workspace console.
  - **The automation card now actually streams**: `vendo_apps_edit` ok-outputs
    that armed an automation emit `data-vendo-automation` from the agent tool
    bridge (name-scoped, 01 §16), and the apps runtime reports the armed
    trigger's true `enabled` state on `EditResult.automation`. The playground
    gallery gains an "Automation created" scenario.

### Patch Changes

- 9532dc0: A turn that builds nothing no longer looks like it is building something.

  Between send and the first streamed chunk the thread painted a document-shaped
  skeleton card under a "Generating…" label. That window has no idea yet whether
  the turn will produce a view: on the live demos it showed on every turn, then
  resolved into plain prose or a refusal, which read as a generated view that had
  failed to arrive.

  The pre-first-chunk window now uses the same quiet liveness indicator every
  other waiting moment in a turn already uses, so the transcript promises nothing
  it may not deliver. Nothing changed about how a real build narrates: tool calls
  still speak through the status ribbon, and a forming generated view still shows
  "Building your view…" on the app card until it settles.

  `.fl-generating` and the `.fl-skeleton` card are removed from the chrome
  stylesheet (`.fl-skeleton-bar` stays — the markdown table's forming row uses
  it). The internal `MessageList` no longer takes `awaitingFirstChunk`.

- d6c231e: One visitor, one anonymous identity — consent-gated actions stop failing silently.

  An anonymous visitor's identity IS the opaque session pointer the door mints on a
  cookie-less wire request, and the door mints one PER REQUEST. A cold page load
  mounts several hooks at once (`/status`, `/approvals`, `/automations`,
  `/activity`, `/connections/catalog`, `/connections`), so every one of them left
  cookie-less and minted its own subject; the browser's jar kept whichever
  `Set-Cookie` landed last and the rest were orphaned. Measured live: one page load
  produced four distinct subjects, three orphaned.

  The damage lands on the trust mechanism at the centre of the product. An agent
  run created its consent approval under one subject, the user's Approve arrived as
  another, and guard correctly refused another subject's approval — surfacing as
  `Approval apr_… was not found` and a run stuck on "waiting for your approval"
  forever. Every consent-gated action failed this way, and the same split emptied
  the activity feed mid-run.

  The browser is the visitor boundary, so `createVendoClient` is the layer that can
  close the race honestly: the first request through a client may leave
  cookie-less, and every request issued before it answers now waits for it and
  travels with the pointer it established. Costs one extra round trip on a cold
  load and nothing afterwards; a failed first request releases the gate rather than
  holding it, so the old behaviour is the floor, never something worse.

  Deliberately NOT solved by fingerprinting the requester (IP/User-Agent would
  merge two real visitors behind one NAT into a single session, sharing threads,
  grants and approvals) nor by deriving the pointer from request attributes (that
  would make a live session guessable, where today it is a 2^128 search). Hosts
  that already mint the pointer on their document response keep working unchanged —
  the door treats a pre-established pointer as canonical.

- Updated dependencies [89153f8]
- Updated dependencies [3ae3d13]
  - @vendoai/core@0.6.0

## 0.5.0

### Minor Changes

- c7277f6: Knowledge verifier pass: where the evidence score provably cannot decide, a cheap model does.

  Calibration against the cloud engine found that answerable and unanswerable questions score in the same range, so at the best possible bar 47% of unanswerable questions still got a confident answer. `@vendoai/knowledge` now exports `entailmentVerifier`: a capped, schema-constrained check that reads the passages a search returned and decides whether they can answer the question at all. An unsupported verdict becomes the existing `insufficient-evidence` outcome, carrying the gap the verifier named so the agent can say WHAT the docs do not cover.

  **It is not score-gated.** It reads every search that returns hits. An earlier design ran it only inside a calibrated score band; the live run showed four unanswerable questions per pass scoring outside that band, never being checked, and being answered — so a check gated on the number it exists to replace inherits that number's blind spots.

  **What it is measured to do.** Live against the cloud engine over the 94-question corpus: false answers 7/34 and 10/34 on its two passes, false refusals 3/60, reading 94/94 searches at 1.37-1.39 model calls per search and adding p50 ~2.5s of verification to a verified turn (summed over that turn's calls; one call's median is ~1.7-1.8s). It reduces confident wrong answers sharply — the same corpus loses 19/34 with the check gated to a score band — but it does not eliminate them, because it cannot refuse when a verification times out and it is sometimes simply wrong. The per-question records and the full table, including the removed gated configuration, are in `docs/eval/KNOWLEDGE.md`.

  **OFF by default.** `VENDO_KNOWLEDGE_VERIFY=on` opts in for the Cloud engine; a value that is neither on nor off throws at composition rather than silently disabling a trust feature. It ships off because the measurement says it does not clear the zero-false-answer bar it exists for, while costing a model call per search and seconds on a call the user waits through — that trade is the host's to make, not a default. Only the Cloud engine composes it; BYO and self-hosted engines are untouched.

  **Enabling the check changes no threshold.** The host's `weakScoreThreshold` (default 0) is exactly what it was, and it still decides every search the check could not read. When there is a verdict the verdict decides, in both directions.

  **It fails open, and says so.** No model, a timeout, or an unusable response yields no verdict: the tool answers the way it would have without a verifier and marks the result with the additive `unverified` field on `vendo/knowledge-result@1`. The thread renders that as the amber "I couldn't check this answer against the documentation" line beside the sources, so a check that did not run is never mistaken for one that passed. Verification is capped per TURN as well as per call, so a chat→deep escalation cannot spend the cap twice.

  An empty or placeholder gap ("", "n/a", "none") fails the verdict schema, so a verdict with its evidence torn off yields no verdict at all and the tool falls open marked, rather than refusing a user with a reason that says nothing.

  The verifier rides its own `knowledgeVerifier` model slot (`VENDO_MODEL_KNOWLEDGE_VERIFIER`, `models.knowledgeVerifier`) beside `judge` — pinning the model that grades answers no longer repoints the one that gates them.

  `@vendoai/knowledge` now declares `ai` as a peer dependency (with the zod floor every ai peer needs), matching `@vendoai/guard`.

- f5fbb4b: Make the MCP door presentable: per-surface tool menus, human tool titles, and
  risk-derived MCP annotations.

  Hosts curate what each surface offers from `.vendo/overrides.json`'s new
  `surfaces` block (`agent` and `mcp`, a closed key set so a misspelled surface
  fails loudly at parse). `ActionsRegistry.surfaceMenu()` resolves it: the
  authored list wins, an absent `agent` menu is unrestricted, and an absent `mcp`
  menu falls back to every merged, enabled tool whose `audience` is `end-user` or
  unset. Menus are curation, not security: the guard, `disabled`, and audience
  exclusions are untouched, an off-menu call returns the same not-found an unknown
  tool returns, and a menu entry naming a missing or disabled tool warns once and
  is skipped rather than taking the host down. Vendo's own `vendo_*` runtime tools
  are never curated away on either surface.

  `ToolDescriptor` and `ToolOverride` gain an optional `title`: the short human
  label for surfaces people read. `vendo sync`'s AI enrichment proposes one per
  tool (presentation, so it is exempt from the restrictive-only clamp and carried
  across structural syncs); `.vendo/overrides.json` corrects it. The door emits it
  in both standard MCP places (top-level `title` and `annotations.title`), and
  approval cards prefer it over the prettified tool id, behind an in-code
  `ToolMeta.label`.

  **Upgrade note.** Every tool the door lists now carries `annotations`
  unconditionally, including for hosts with no `surfaces` block. That means a
  `read` tool asserts `readOnlyHint: true` to clients, and some MCP clients use
  that hint to skip their own confirmation prompt for read calls. Nothing changes
  server-side: Vendo's guard, policy, approvals, and audit decide exactly what
  they decided before, and annotations are hints the spec says clients may
  ignore. If you have a `read`-labelled tool that is not actually side-effect
  free, correct its `risk` in `.vendo/overrides.json` — that label was already
  driving your policy.

  Every tool the door lists now also carries `annotations` derived from its risk
  label (`read` → `readOnlyHint`, `destructive` → `destructiveHint`), and the door
  serves a themed, script-free, unauthenticated connect page at `{mount}/connect`
  with the MCP URL and per-client setup steps for Claude, ChatGPT, and Cursor.
  demo-bank ships a curated twelve-tool menu as the worked example.

- d1364b6: Chrome wave: split-view workspace with morphing stage, compact embeds, staged blur, stage pinning (host onPin seam), AutomationCard, ConnectCard lifecycle states, landing composer, docked new-reply banner, streaming skeletons, WorkingRibbon, connect-dock resilience, ApprovalSheet fixes, approvals-decided resume event, and eventOutcomeLabel stream-part semantics.

### Patch Changes

- Updated dependencies [0b58e3e]
- Updated dependencies [cbffc9e]
- Updated dependencies [c7277f6]
- Updated dependencies [da9d4a9]
- Updated dependencies [f5fbb4b]
- Updated dependencies [221b851]
- Updated dependencies [d1364b6]
  - @vendoai/core@0.5.0

## 0.4.8

### Patch Changes

- @vendoai/core@0.4.8

## 0.4.7

### Patch Changes

- fd9260d: Empty-states batch — a fresh install's FIRST generated app now renders well
  with no bindable host data. Generation always emits the requested component
  bound to its tool (the Kit renders the designed empty state) instead of
  omitting it or writing prose into a tile; the no-data explanation is one
  consolidated "About this view" note, charts route to the Kit, and the app
  name is a <=40-char display title (validated on create) instead of the
  request echoed back. The Kit stat tile shows a compact em dash for empty
  values and truncates prose-length text into a tooltip, empty label/value
  pairs render an em dash, and the in-thread app panel scrolls its top into
  view when a live build settles. The create-app tool description also stops
  callers baking pre-computed figures or branding into the prompt.
  - @vendoai/core@0.4.7

## 0.4.6

### Patch Changes

- 60c5e39: A create_app build can no longer die silently (0.4.5 E2E cert defect D, byo-ai-sdk host). Three layers: a build whose every region was disclaimed away ("This part of the request isn't available on this host.") now fails terminally with an honest host-capability reason instead of persisting as a "successful" app that reads as a build hanging forever; a server-side build watchdog persists a terminal failed record when a build task neither completes nor throws inside its window (VENDO_APP_BUILD_WATCHDOG_MS, default 4 min), so the embed always resolves even if the build promise hangs or is severed by the host runtime; and the embed's build deadline is now an absolute client-side timer with a per-poll timeout, so a hung open() poll can no longer freeze the building beat past the deadline.
  - @vendoai/core@0.4.6

## 0.4.5

### Patch Changes

- 31f899e: A chat turn whose app build terminally fails now ENDS, with the classified
  failure reason visible in the thread. Before, the failed build came back as a
  plain error outcome only the model could see: the tray rendered nothing, and
  the model re-ran the minutes-long doomed build inside the same turn until the
  step cap — a thread stuck "streaming" for 10+ minutes with no banner and no
  reason (0.4.4 E2E cert). The agent's tool bridge now streams an additive
  `data-vendo-build-failed` part (toolCallId + the runtime's canned, non-leaky
  reason) beside the failed `vendo_apps_create` result, the agent loop stops the
  turn after the failed build (re-asking is the user's call, matching the BYO
  embed's failed vocabulary), and the thread renders the part as an error beat
  with the reason.

  The generation engine also names an empty model stream as its own failure
  class ("completed without any text output") instead of reporting the empty
  string's wire-parse issues — the 0.4.4 cert's "wire missing-app / empty
  layout" failures were a gateway alias ending turns reasoning-only, not a
  model-format defect, and the old issue list mis-routed that triage.

- Updated dependencies [31f899e]
  - @vendoai/core@0.4.5

## 0.4.4

### Patch Changes

- 89e3d2b: Mid-stream turn errors are no longer a dead end: the agent logs the real
  error server-side ("[vendo] turn stream error") and passes its OWN safe
  errors (VendoError code + message) to the wire recognizably prefixed, while
  raw provider/transport strings stay the fixed generic text. The thread
  error banner renders that safe detail line (code included) next to Retry —
  "Something went wrong" alone is now reserved for errors we genuinely can't
  say more about.
- Updated dependencies [835d17a]
  - @vendoai/core@0.4.4

## 0.4.3

### Patch Changes

- a48b1b7: Wave 2 runtime fixes from the 0.4.x E2E certification campaign:

  - Mastra shim: open-schema guarded tools (extracted routes whose body shape
    is untyped) no longer execute with `{}` when the user dictated args.
    Mastra's provider schema-compat layers hard-close every object schema for
    strict-mode providers, so an open input reached the model as "takes no
    arguments"; the shim now bridges open inputs through one declared `args`
    property (JSON object or JSON-encoded string) and unwraps it before the
    guard, so approvals park — and replay — with the real arguments.
  - Failed app builds now carry their reason everywhere: `create()` re-throws
    with the classified reason in the message (the tool outcome the calling
    agent reads), logs the un-canned issue list to the operator terminal
    (previously a silent failure), and the app embed shows a retry hint for
    retryable failures. The generation engine now captures streamText's
    swallowed provider errors, so quota/timeout/no-key failures classify
    correctly instead of collapsing to "generation failed".
  - The dev model's no-usable-credential lines (missing provider package, no
    key at all) surface verbatim in the failed-build reason — the in-surface
    error now carries the actionable `npm install @ai-sdk/...` / `vendo login`
    instruction instead of `model could not produce a valid app`.
  - `@vendoai/ui` DonutChart no longer crashes on `undefined`/non-array data
    inside generated apps; it renders the designed empty state like the other
    Kit charts.
  - @vendoai/core@0.4.3

## 0.4.2

### Patch Changes

- @vendoai/core@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies [b7a860f]
  - @vendoai/core@0.4.1

## 0.4.0

### Minor Changes

- 4b8ac66: Per-user connected accounts via the Composio broker (ENG-262). Connectors gain a subject-scoped `connections` capability (list/initiate/status/disconnect); the umbrella serves per-principal `/connections` endpoints with a Vendo Cloud broker seam behind `VENDO_API_KEY`; a Composio call missing a connection returns the new typed `connect-required` tool outcome, rendered by `VendoThread` as an inline connect card that retries after connecting; `ConnectedAccountsPanel` (list + disconnect) joins the chrome as the accounts tab. Composio tools carry curated risk (metadata hints + slug patterns) instead of a blanket `write`; the MCP connector accepts an async per-principal `headers` resolver with per-subject sessions; every connector execution is audited with its account identity.
- a7d57b7: Composer upgrades (ENG-215): the message textarea now autogrows with its content
  (caps at max-height, then scrolls); typing is never blocked while a turn streams;
  a message sent mid-turn visibly queues and auto-sends the moment the turn
  completes (Stop stays the explicit interrupt). Adds Edit on the last user turn
  (refills the composer and drops the turn so re-sending amends rather than
  duplicates) and Regenerate on the last assistant turn. Fixes the focus dump to
  `<body>` that used to break Escape and the overlay focus trap when the composer
  disabled mid-turn. `useVendoThread` now exposes `setMessages` for headless parity.
- e9c538c: Tool & approval humanization (ENG-216): add an additive, UI-side host-metadata
  seam (`VendoProvider` `tools` prop — friendly labels, descriptions, and custom
  arg summarizers per tool) with a formatting fallback that prettifies raw tool
  ids and formats args into readable summaries. Tool chips no longer show the raw
  slug or the ai-SDK lifecycle string, consecutive identical tool chips collapse
  into one entry with a count, and the in-thread `ApprovalCard` no longer
  fabricates or displays a context byline (the queue path keeps its real
  server-provided `ctx`). No contract or wire changes.
- da4d3e8: Extreme-content solidity (ENG-218): the thread stays smooth no matter how long
  the transcript or how large a single message. Long threads are windowed — only a
  bounded trailing slice of turns is in the DOM, with a "Show N earlier messages"
  control that reveals the deferred head in chunks and anchors the viewport so the
  reader is never yanked. Entrance animations are gated on restore, so reopening a
  200-turn thread no longer fires every `fl-item-in` rise at once. Markdown is
  memoized so a streaming turn only re-parses the block that changed instead of
  re-parsing every settled turn per token, and a restored huge message (pasted
  logs, model dumps) collapses behind a "Show full message" expander that bounds
  both parse time and node count. Raw tool-payload previews in the approval card
  are likewise capped. Stick-to-bottom and jump-to-latest are preserved under all
  of the above.
- a2ca8e2: Palette + Page fixes (ENG-222). `VendoPalette`'s keybinding is now a
  host-collision-safe singleton: one shared listener no matter how many palettes
  mount (no more double-toggle across mounts), a configurable `hotkey` prop
  (a chord like `{ key: "k", meta: true }`, a custom matcher function, or `false`
  to disable the keyboard opener entirely), and it no longer steals a keystroke
  from a focused host input while closed. `VendoThread` gains an optional
  `onThreadId` callback that fires with the effective (possibly server-minted)
  thread id. `VendoPage`'s chat sidebar now refreshes when a conversation started
  via "New conversation" mints its thread, so the new conversation appears (and
  highlights) instead of never showing; an explicit selection also survives a
  background list refresh.
- b819ab2: Slot: wire the empty-state CTA + pinned-component placement path (ENG-223).
  `VendoSlot`'s empty state is now a real, focusable `<button>` (was a
  non-interactive div): activating it opens the authoring surface via the new
  optional `onAuthor(slotId)` prop, and — when no handler is supplied — opens a
  mounted `VendoPalette` through the new `openVendoPalette()` singleton opener
  (host-collision-safe like the keybinding; a no-op when no palette is mounted).
  `VendoSlot` also gains a `pin` prop for the "or a pinned component" path in
  08-ui §4: a pinned `vendo-genui/v1` view (`{ payload, data?, onAction? }`)
  now mounts in place through the tree renderer and the PinMount error boundary,
  falling back to the host's original children if it throws — previously a slot
  could only mount a whole app, so hosts pinning a generated component had to
  bypass `VendoSlot` with a bare `AppFrame` (no fallback). The Cadence demo hero
  slot is switched to this path.
- 75cb256: Activity panel rebuild (ENG-224): the self-scoped activity surface now renders
  real semantics instead of a raw data dump. Each row is a concrete action taken
  as the user — a kind badge (Tool, Approval, Connection, …) plus a humanized
  action label (host tool metadata wins, else the prettified slug, never a raw
  id), a plain-language result (Succeeded / Failed / Awaiting approval / Blocked /
  Connect required / Running) with a status glyph, and a human, timezone-stable
  timestamp ("Jul 11, 2026, 12:00 PM") in place of the raw ISO instant. Pagination
  now ends in an explicit end-of-list marker: `useActivity` exposes `hasMore`, which
  flips to `false` once a page adds no new events, so "Load more" retires instead of
  re-fetching nothing. No contract or wire changes.
- 5093682: Implement the full dead-CSS affordance set (ENG-225): copy actions on every
  settled turn, code-block copy, drag-drop attach with image preview chips and
  sent-attachment rendering in the transcript, the waiting-on-you approval queue
  (mounted in VendoPage chat, exported as `WaitingQueue`), the `VendoToasts`
  delivery surface with an imperative `vendoToast()` API and opt-in
  approval-required toasts, and the connect dock + liquid tray in the composer
  (new optional `connectors` catalog on `VendoProvider`; `ConnectCard`'s
  initiate → OAuth → poll flow is now the shared `completeConnection`).
- 083a3b9: Voice v1, the full designed stage (ENG-229): resilient realtime driver
  (connect timeout, bounded reconnect with fresh re-dial, mute via track.enabled,
  live amplitude, humanized failure messages) and the rebuilt `VendoStage` —
  amplitude-driven blob, two-row sticky captions, transcript drawer, consent bar
  (approvals decidable mid-call, with receipts), renderer-backed session-view
  feed with slide focus + dots, reconnecting/error banners with Retry, and exit
  settle choreography (`onSessionEnd`). `useVoice()` additionally returns
  `error`, `muted`, `setMuted`, `amplitude`, and `views`.
- 0f17f39: Voice live pipeline — the realtime tool-call bridge (ENG-319). The realtime
  driver gains an optional `act: VoiceToolBridge`: its `tools` ride the provider
  `session.update` and every model function call funnels through `onToolCall`,
  whose resolved value returns to the model as the function output. The shipped
  `createVoiceActBridge({ client })` exposes one `vendo_act` tool that runs a REAL
  guarded agent turn per call over `POST /threads` — minted views stream into the
  stage feed via `VoiceActSession.emitView`, parked guard approvals reach the
  stage consent bar (ENG-229), and the turn resumes through the existing
  assistant-upsert approval-response path with the guard authoritative over
  execution. No new server surface, no wire change; Maple's voice driver is wired
  to it. Additive 08-ui amendment parked for Yousef sign-off.
- ff6b5d5: Principals + orgs (ENG-263). Anonymous→signed-in auto-merge: the first authenticated request carrying a valid anon cookie adopts the session's threads/apps/state into the real subject and retires the cookie — idempotently, without ever overwriting an existing row; grants, approvals, and connected accounts deliberately do not migrate (consent doesn't transfer identities). Away re-verification rides actAs: the host declining to mint fails the run closed, and every actAs-authenticated call audits its disposition (`detail.actAs`). Runtime-minted subjects move into the reserved `vendo:` namespace (`vendo:webhook:<source>`); host principal resolvers producing reserved subjects (or org-kind principals) are rejected loudly. `kind:"org"` and the `vendo:org:<id>` subject shape remain reserved but inert — no org storage, management surface, or activation ships in this release.
- 0c10661: Add the Kit (`@vendoai/ui/kit`): 31 smart, host-brand-native, generative-UI components — a strict superset of Crayon/Tambo/json-render/Tremor surfaces. Layout, a semantic value tier (Money takes integer cents, dates/percent/num Intl-formatted, `$NaN`/`Invalid Date` unrenderable), a TanStack-Table DataTable (sort/filter/search/paginate/dot-path columns/per-column format/named-query empty state), recharts charts (Line/Bar/Donut/Sparkline/Progress with designed empty/invalid states), forms (Select over raw object arrays, action-gated Button, first-class Disclaimer), and self-managing Tabs/Callout/Accordion. Every prop is zod-schema'd and classed `config | copy | data`; `kitPrompt()` renders the model-facing prompt from those schemas. The existing prewired set is unchanged.

### Patch Changes

- 51f3fc9: Fix (ENG-353): heartbeat-armed idle-abort fallback for client disconnects the runtime never surfaces. Under `next dev` a real browser's graceful tab-close/navigate-away fires neither `request.signal` nor a stream cancel, so an abandoned turn ran to completion and burned provider tokens. The panel now beats `POST /threads/:id/heartbeat` while a turn streams; the first beat arms a server-side idle watchdog that aborts the turn through the same controller as the fast path after ~15s of silence. The fetch-abort fast path is unchanged, and consumers that never beat (curl/scripted clients) keep exact run-to-completion semantics.
- Updated dependencies [49e9ccc]
- Updated dependencies [0032a67]
- Updated dependencies [b6def0f]
- Updated dependencies [4b8ac66]
- Updated dependencies [fa0ad98]
- Updated dependencies [51f3fc9]
- Updated dependencies [ff6b5d5]
  - @vendoai/core@0.4.0
