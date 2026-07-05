import { Callout as UICallout } from "../../openui.js";
import { createPrewiredImpl } from "../../impl-helpers/create-impl.js";
import { calloutSchema } from "./descriptor.js";

export const Callout = createPrewiredImpl(calloutSchema, (p) => (
  <UICallout
    variant={p.variant}
    title={p.title ? <span>{p.title}</span> : undefined}
    description={<span>{p.text}</span>}
  />
));
