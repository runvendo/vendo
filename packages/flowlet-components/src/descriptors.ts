import type { RegisteredComponent } from "@flowlet/core";
import type { PrewiredDescriptor } from "./descriptor";
import { cardDescriptor } from "./components/Card/descriptor";
import { tableDescriptor } from "./components/Table/descriptor";
import { chartDescriptor } from "./components/Chart/descriptor";
import { formDescriptor } from "./components/Form/descriptor";

export const descriptors: PrewiredDescriptor[] = [
  cardDescriptor,
  tableDescriptor,
  chartDescriptor,
  formDescriptor,
];

export const prewiredComponents: RegisteredComponent[] = descriptors.map((d) => d.toRegistered());
