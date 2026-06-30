import { Tabs as UITabs, TabsList, TabsTrigger, TabsContent } from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { tabsSchema } from "./descriptor";

export const Tabs = createPrewiredImpl(tabsSchema, (p) => {
  const firstValue = p.tabs[0]?.label ?? "";
  return (
    <UITabs defaultValue={firstValue}>
      <TabsList>
        {p.tabs.map((tab) => (
          <TabsTrigger key={tab.label} value={tab.label} text={<span>{tab.label}</span>} />
        ))}
      </TabsList>
      {p.tabs.map((tab) => (
        <TabsContent key={tab.label} value={tab.label}>
          {tab.content}
        </TabsContent>
      ))}
    </UITabs>
  );
});
