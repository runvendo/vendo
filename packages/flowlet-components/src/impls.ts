import type { ComponentType } from "react";
import { Card } from "./components/Card/impl";
import { Table } from "./components/Table/impl";
import { Chart } from "./components/Chart/impl";
import { Form } from "./components/Form/impl";
import { Accordion } from "./components/Accordion/impl";
import { Carousel } from "./components/Carousel/impl";
import { Callout } from "./components/Callout/impl";
import { Tags } from "./components/Tags/impl";
import { Steps } from "./components/Steps/impl";

export const prewiredImpls: Record<string, ComponentType<Record<string, unknown>>> = {
  Card,
  Table,
  Chart,
  Form,
  Accordion,
  Carousel,
  Callout,
  Tags,
  Steps,
};
