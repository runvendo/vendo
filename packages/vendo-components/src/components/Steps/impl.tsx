import { Steps as UISteps, StepsItem } from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { stepsSchema } from "./descriptor";

export const Steps = createPrewiredImpl(stepsSchema, (p) => (
  <UISteps>
    {p.steps.map((step, i) => (
      <StepsItem
        key={i}
        number={i + 1}
        title={step.title ? <span>{step.title}</span> : <span>{`Step ${i + 1}`}</span>}
        details={<span>{step.text}</span>}
      />
    ))}
  </UISteps>
));
