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
];

export const prewiredComponents: RegisteredComponent[] = descriptors.map((d) => d.toRegistered());
