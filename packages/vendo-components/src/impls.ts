import type { ComponentType } from "react";
import { Card } from "./components/Card/impl.js";
import { Table } from "./components/Table/impl.js";
import { Chart } from "./components/Chart/impl.js";
import { Sankey } from "./components/Sankey/impl.js";
import { Form } from "./components/Form/impl.js";
import { Accordion } from "./components/Accordion/impl.js";
import { Carousel } from "./components/Carousel/impl.js";
import { Callout } from "./components/Callout/impl.js";
import { Tags } from "./components/Tags/impl.js";
import { Steps } from "./components/Steps/impl.js";
import { List } from "./components/List/impl.js";
import { Image } from "./components/Image/impl.js";
import { ImageGallery } from "./components/ImageGallery/impl.js";
import { Markdown } from "./components/Markdown/impl.js";
import { CodeBlock } from "./components/CodeBlock/impl.js";
import { Tabs } from "./components/Tabs/impl.js";
import { TimeOfDayClock } from "./components/TimeOfDayClock/impl.js";
import { Progress } from "./components/Progress/impl.js";
import { Donut } from "./components/Donut/impl.js";
import { KeyValue } from "./components/KeyValue/impl.js";
import { Actions } from "./components/Actions/impl.js";
import { EmptyState } from "./components/EmptyState/impl.js";

export const prewiredImpls: Record<string, ComponentType<Record<string, unknown>>> = {
  TimeOfDayClock,
  Card,
  Table,
  Chart,
  Sankey,
  Form,
  Accordion,
  Carousel,
  Callout,
  Tags,
  Steps,
  List,
  Image,
  ImageGallery,
  Markdown,
  CodeBlock,
  Tabs,
  Progress,
  Donut,
  KeyValue,
  Actions,
  EmptyState,
};
