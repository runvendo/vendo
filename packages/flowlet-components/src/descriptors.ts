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

export const descriptors: PrewiredDescriptor[] = [
  cardDescriptor,
  tableDescriptor,
  chartDescriptor,
  formDescriptor,
  accordionDescriptor,
  carouselDescriptor,
  calloutDescriptor,
  tagsDescriptor,
];

export const prewiredComponents: RegisteredComponent[] = descriptors.map((d) => d.toRegistered());
