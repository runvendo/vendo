import { FormControl, Label, Input, TextArea } from "../../openui.js";
import { createPrewiredImpl } from "../../impl-helpers/create-impl.js";
import { formSchema } from "./descriptor.js";
import type { z } from "zod";
import type { formFieldSchema } from "./descriptor.js";

type FormField = z.infer<typeof formFieldSchema>;

function renderInput(f: FormField) {
  switch (f.type) {
    case "text":
      return <Input id={f.name} type="text" name={f.name} placeholder={f.placeholder} required={f.required} />;
    case "number":
      return <Input id={f.name} type="number" name={f.name} placeholder={f.placeholder} required={f.required} />;
    case "textarea":
      return <TextArea id={f.name} name={f.name} placeholder={f.placeholder} required={f.required} />;
    case "checkbox":
      return <Input id={f.name} type="checkbox" name={f.name} required={f.required} />;
    case "switch":
      return <Input id={f.name} type="checkbox" role="switch" name={f.name} />;
    case "slider":
      return <Input id={f.name} type="range" name={f.name} min={f.min} max={f.max} />;
    case "date":
      return <Input id={f.name} type="date" name={f.name} />;
    case "select":
      return (
        <select id={f.name} name={f.name} required={f.required}>
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    case "radio":
      return (
        <div id={f.name} role="radiogroup">
          {f.options.map((o) => (
            <label key={o.value}>
              <input type="radio" name={f.name} value={o.value} />
              {o.label}
            </label>
          ))}
        </div>
      );
    case "toggle":
      return (
        <div id={f.name} role="group">
          {f.options.map((o) => (
            <button key={o.value} type="button" value={o.value}>{o.label}</button>
          ))}
        </div>
      );
  }
}

export const Form = createPrewiredImpl(formSchema, (p) => (
  <form onSubmit={(e) => e.preventDefault()}>
    {p.title ? <h3>{p.title}</h3> : null}
    {p.fields.map((f) => (
      <FormControl key={f.name}>
        <Label htmlFor={f.name}>{f.label}</Label>
        {renderInput(f)}
      </FormControl>
    ))}
    <button type="submit" disabled>{p.submitLabel}</button>
  </form>
));
