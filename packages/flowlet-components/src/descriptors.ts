import type { RegisteredComponent } from "@flowlet/core";
import type { PrewiredDescriptor } from "./descriptor";
import { cardDescriptor } from "./components/Card/descriptor";
import { tableDescriptor } from "./components/Table/descriptor";
import { chartDescriptor } from "./components/Chart/descriptor";
import { formDescriptor } from "./components/Form/descriptor";
import { accordionDescriptor } from "./components/Accordion/descriptor";
import { carouselDescriptor } from "./components/Carousel/descriptor";
import { calloutDescriptor } from "./components/Callout/descriptor";
import { tagsDescriptor } from "./components/Tags/descriptor";
import { stepsDescriptor } from "./components/Steps/descriptor";
import { listDescriptor } from "./components/List/descriptor";
import { imageDescriptor } from "./components/Image/descriptor";
import { imageGalleryDescriptor } from "./components/ImageGallery/descriptor";
import { markdownDescriptor } from "./components/Markdown/descriptor";
import { codeBlockDescriptor } from "./components/CodeBlock/descriptor";
import { tabsDescriptor } from "./components/Tabs/descriptor";
import { timeOfDayClockDescriptor } from "./components/TimeOfDayClock/descriptor";
import { progressDescriptor } from "./components/Progress/descriptor";
import { donutDescriptor } from "./components/Donut/descriptor";
import { keyValueDescriptor } from "./components/KeyValue/descriptor";
import { actionsDescriptor } from "./components/Actions/descriptor";
import { emptyStateDescriptor } from "./components/EmptyState/descriptor";

export const descriptors: PrewiredDescriptor[] = [
  timeOfDayClockDescriptor,
  cardDescriptor,
  tableDescriptor,
  chartDescriptor,
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
export { brandTokensSchema, defaultBrand, type BrandTokens } from "./theme/brand";
export { brandToCssVars } from "./theme/brand-to-css-vars";
export { brandToChartPalette } from "./theme/brand-to-chart-palette";
export { hostComponent, toHostRegistry, type HostComponentDescriptor } from "./host-component";
export { jsonValue } from "./descriptor";
