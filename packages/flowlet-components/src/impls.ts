import type { ComponentType } from "react";
import { Card } from "./components/Card/impl";
import { Table } from "./components/Table/impl";
import { Chart } from "./components/Chart/impl";
import { Form } from "./components/Form/impl";

export const prewiredImpls: Record<string, ComponentType<Record<string, unknown>>> = {
  Card,
  Table,
  Chart,
  Form,
};
