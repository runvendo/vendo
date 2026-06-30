import { Tabs as UITabs, TabsList, TabsTrigger, TabsContent } from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { tabsSchema } from "./descriptor";

export const Tabs = createPrewiredImpl(tabsSchema, (p) => {
  const firstValue = "0";
  return (
    <UITabs defaultValue={firstValue}>
      <TabsList>
        {p.tabs.map((tab, i) => (
          <TabsTrigger key={i} value={String(i)} text={<span>{tab.label}</span>} />
        ))}
      </TabsList>
      {p.tabs.map((tab, i) => (
        <TabsContent key={i} value={String(i)}>
          {tab.content}
        </TabsContent>
      ))}
    </UITabs>
  );
});
