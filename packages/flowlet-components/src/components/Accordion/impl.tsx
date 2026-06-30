import {
  Accordion as UIAccordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { accordionSchema } from "./descriptor";

export const Accordion = createPrewiredImpl(accordionSchema, (p) => {
  const allValues = p.items.map((_, i) => `item-${i}`);
  return (
    <UIAccordion type="multiple" variant="card" defaultValue={allValues}>
      {p.items.map((item, i) => (
        <AccordionItem key={i} value={`item-${i}`}>
          <AccordionTrigger text={<span>{item.title}</span>} />
          <AccordionContent>{item.content}</AccordionContent>
        </AccordionItem>
      ))}
    </UIAccordion>
  );
});
