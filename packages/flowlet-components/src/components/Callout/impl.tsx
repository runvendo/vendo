import { Callout as UICallout } from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { calloutSchema } from "./descriptor";

export const Callout = createPrewiredImpl(calloutSchema, (p) => (
  <UICallout
    variant={p.variant}
    title={p.title ? <span>{p.title}</span> : undefined}
    description={<span>{p.text}</span>}
  />
));
