import type { RegisteredComponent } from "@vendoai/core";
import type { PrewiredDescriptor } from "./descriptor.js";
import { cardDescriptor } from "./components/Card/descriptor.js";
import { tableDescriptor } from "./components/Table/descriptor.js";
import { chartDescriptor } from "./components/Chart/descriptor.js";
import { sankeyDescriptor } from "./components/Sankey/descriptor.js";
import { formDescriptor } from "./components/Form/descriptor.js";
import { accordionDescriptor } from "./components/Accordion/descriptor.js";
import { carouselDescriptor } from "./components/Carousel/descriptor.js";
import { calloutDescriptor } from "./components/Callout/descriptor.js";
import { tagsDescriptor } from "./components/Tags/descriptor.js";
import { stepsDescriptor } from "./components/Steps/descriptor.js";
import { listDescriptor } from "./components/List/descriptor.js";
import { imageDescriptor } from "./components/Image/descriptor.js";
import { imageGalleryDescriptor } from "./components/ImageGallery/descriptor.js";
import { markdownDescriptor } from "./components/Markdown/descriptor.js";
import { codeBlockDescriptor } from "./components/CodeBlock/descriptor.js";
import { tabsDescriptor } from "./components/Tabs/descriptor.js";
import { timeOfDayClockDescriptor } from "./components/TimeOfDayClock/descriptor.js";
import { progressDescriptor } from "./components/Progress/descriptor.js";
import { donutDescriptor } from "./components/Donut/descriptor.js";
import { keyValueDescriptor } from "./components/KeyValue/descriptor.js";
import { actionsDescriptor } from "./components/Actions/descriptor.js";
import { emptyStateDescriptor } from "./components/EmptyState/descriptor.js";

export const descriptors: PrewiredDescriptor[] = [
  timeOfDayClockDescriptor,
  cardDescriptor,
  tableDescriptor,
  chartDescriptor,
  sankeyDescriptor,
  formDescriptor,
  accordionDescriptor,
  carouselDescriptor,
  calloutDescriptor,
  tagsDescriptor,
  stepsDescriptor,
  listDescriptor,
  imageDescriptor,
  imageGalleryDescriptor,
  markdownDescriptor,
  codeBlockDescriptor,
  tabsDescriptor,
  progressDescriptor,
  donutDescriptor,
  keyValueDescriptor,
  actionsDescriptor,
  emptyStateDescriptor,
];

export const prewiredComponents: RegisteredComponent[] = descriptors.map((d) => d.toRegistered());

// Server-safe theme utilities (React-free, no CSS imports) — the descriptors
// entrypoint is the one server code may import, so the token → CSS-var / chart
// palette derivations are re-exported here for prompt assembly and manifests.
export { brandTokensSchema, defaultBrand, type BrandTokens } from "./theme/brand.js";
export { brandToCssVars } from "./theme/brand-to-css-vars.js";
export { brandToChartPalette } from "./theme/brand-to-chart-palette.js";
export { hostComponent, toHostRegistry, type HostComponentDescriptor } from "./host-component.js";
export { componentPromptCatalog } from "./prompt-catalog.js";
export { jsonValue } from "./descriptor.js";
